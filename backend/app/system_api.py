from __future__ import annotations

import json
import logging
import re
import shutil
import sqlite3
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from .auth import (
    current_token_hash,
    hash_password,
    issue_session,
    public_user,
    require_user,
    verify_password,
)
from .config import get_settings
from .log_integration import IncidentGraphIntegrator, LogFaultRunner
from .models import (
    EdgeDeleteRequest,
    EdgeUpdateRequest,
    EdgeUpsertRequest,
    NodeUpdateRequest,
    NodeUpsertRequest,
)
from .scoped_graph import ProjectScopedGraphClient
from .service import GraphBuilderService
from .system_db import SystemDatabase, get_system_db
from .system_models import (
    IncidentStatusRequest,
    LoginRequest,
    ProjectCreateRequest,
    ProjectUpdateRequest,
    RegisterRequest,
)


logger = logging.getLogger("logsys-system")
router = APIRouter(prefix="/api")


def _json(value: Any, fallback: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value or ""))
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback


def _project_for_user(
    project_id: str,
    user: dict[str, Any],
    database: SystemDatabase | None = None,
) -> dict[str, Any]:
    project = (database or get_system_db()).get_project(project_id)
    if not project or project.get("owner_id") != user.get("id"):
        # Returning 404 avoids leaking project identifiers between users.
        raise HTTPException(status_code=404, detail="项目不存在")
    return project


def _incident_for_user(
    project_id: str,
    incident_id: str,
    user: dict[str, Any],
    database: SystemDatabase | None = None,
) -> dict[str, Any]:
    db = database or get_system_db()
    _project_for_user(project_id, user, db)
    incident = db.get_incident(incident_id)
    if not incident or incident.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="故障记录不存在")
    return incident


def _clean_name(value: str | None, fallback: str) -> str:
    raw = Path(value or fallback).name
    clean = re.sub(r"[^A-Za-z0-9._\-\u4e00-\u9fa5]", "_", raw).strip("._")
    return clean[:180] or fallback


async def _read_upload(file: UploadFile) -> bytes:
    raw = await file.read()
    max_bytes = max(1, get_settings().max_upload_mb) * 1024 * 1024
    if len(raw) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"文件超过 {get_settings().max_upload_mb} MB 限制",
        )
    if not raw:
        raise HTTPException(status_code=400, detail="上传文件为空")
    return raw


def _data_dir(project_id: str, category: str, item_id: str) -> Path:
    root = Path(get_settings().app_data_root).expanduser().resolve()
    path = root / "projects" / project_id / category / item_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def _public_project(project: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in project.items() if key != "owner_id"}


def _architecture_result(item: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in item.items()
        if key not in {"source_text", "execution_logs_json", "graph_snapshot_json"}
    }


def _batch_result(item: dict[str, Any]) -> dict[str, Any]:
    result = {
        key: value
        for key, value in item.items()
        if key not in {"input_path", "train_path", "rca_json"}
    }
    result["summary"] = _json(result.pop("summary_json", "{}"), {})
    return result


def _incident_result(item: dict[str, Any], detailed: bool = False) -> dict[str, Any]:
    result = dict(item)
    result["chain"] = _json(result.pop("chain_json", "[]"), [])
    if detailed:
        result["analysis"] = _json(result.pop("analysis_json", "{}"), {})
        result["detail"] = _json(result.pop("detail_json", "{}"), {})
    else:
        result.pop("analysis_json", None)
        result.pop("detail_json", None)
    return result


# Authentication -----------------------------------------------------------


@router.post("/auth/register", status_code=201)
def register(payload: RegisterRequest) -> dict[str, Any]:
    settings = get_settings()
    database = get_system_db()
    if not settings.allow_registration and database.user_count() > 0:
        raise HTTPException(status_code=403, detail="系统已关闭自助注册")
    try:
        user = database.create_user(
            payload.username.strip(),
            hash_password(payload.password),
            payload.display_name.strip(),
        )
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="用户名已存在") from exc
    token, expires_at = issue_session(str(user["id"]))
    return {"token": token, "expires_at": expires_at, "user": public_user(user)}


@router.post("/auth/login")
def login(payload: LoginRequest) -> dict[str, Any]:
    database = get_system_db()
    user = database.get_user_by_username(payload.username.strip())
    if not user or not verify_password(payload.password, str(user.get("password_hash") or "")):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    if not int(user.get("is_active") or 0):
        raise HTTPException(status_code=403, detail="账户已停用")
    token, expires_at = issue_session(str(user["id"]))
    return {"token": token, "expires_at": expires_at, "user": public_user(user)}


@router.get("/auth/me")
def me(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    return {"user": public_user(user)}


@router.post("/auth/logout")
def logout(
    user: dict[str, Any] = Depends(require_user),
    hashed_token: str = Depends(current_token_hash),
) -> dict[str, Any]:
    del user
    get_system_db().delete_session(hashed_token)
    return {"message": "logged_out"}


# Projects -----------------------------------------------------------------


@router.get("/projects")
def list_projects(
    include_archived: bool = Query(False),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    items = get_system_db().list_projects(str(user["id"]), include_archived)
    return {"items": [_public_project(item) for item in items]}


@router.post("/projects", status_code=201)
def create_project(
    payload: ProjectCreateRequest,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    item = get_system_db().create_project(
        str(user["id"]), payload.name.strip(), payload.description.strip()
    )
    return {"project": _public_project(item)}


@router.get("/projects/{project_id}")
def get_project(
    project_id: str,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    return {"project": _public_project(_project_for_user(project_id, user))}


@router.put("/projects/{project_id}")
def update_project(
    project_id: str,
    payload: ProjectUpdateRequest,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    _project_for_user(project_id, user, database)
    item = database.update_project(
        project_id, payload.name.strip(), payload.description.strip(), payload.status
    )
    return {"project": _public_project(item)}


@router.delete("/projects/{project_id}")
def archive_project(
    project_id: str,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    project = _project_for_user(project_id, user, database)
    updated = database.update_project(
        project_id, str(project["name"]), str(project.get("description") or ""), "archived"
    )
    return {"message": "project_archived", "project": _public_project(updated)}


@router.get("/projects/{project_id}/dashboard")
def project_dashboard(
    project_id: str,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    project = _project_for_user(project_id, user, database)
    return {"project": _public_project(project), "dashboard": database.dashboard(project_id)}


# Architecture and graph ---------------------------------------------------


@router.get("/projects/{project_id}/architectures")
def list_architectures(
    project_id: str,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    _project_for_user(project_id, user, database)
    return {
        "items": [
            _architecture_result(item)
            for item in database.list_architecture_imports(project_id)
        ]
    }


@router.post("/projects/{project_id}/architectures/import", status_code=201)
async def import_architecture(
    project_id: str,
    file: UploadFile = File(...),
    name: str = Form(""),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    _project_for_user(project_id, user, database)
    raw = await _read_upload(file)
    filename = _clean_name(file.filename, "architecture.md")
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        raise HTTPException(status_code=400, detail="架构描述没有可读取的文本")
    item = database.create_architecture_import(
        project_id,
        (name.strip() or Path(filename).stem)[:120],
        filename,
        text,
        str(user["id"]),
    )
    scoped = ProjectScopedGraphClient(project_id)
    try:
        extracted, logs = await run_in_threadpool(
            GraphBuilderService(scoped).build_ontology_graph,
            text,
            filename,
        )
        graph = await run_in_threadpool(scoped.read_architecture_graph, 3000)
        database.complete_architecture_import(
            str(item["id"]),
            len(extracted.get("services") or []),
            len(extracted.get("calls") or []),
            json.dumps(logs, ensure_ascii=False),
            json.dumps(graph.model_dump(), ensure_ascii=False),
        )
        completed = database.get_architecture_import(str(item["id"])) or item
        return {
            "message": "architecture_imported",
            "architecture": _architecture_result(completed),
            "extracted": extracted,
            "execution_logs": logs,
            "graph": graph.model_dump(),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("Architecture import failed project=%s", project_id)
        database.fail_architecture_import(str(item["id"]), str(exc))
        raise HTTPException(status_code=500, detail=f"架构导入失败：{exc}") from exc


@router.get("/projects/{project_id}/graph")
def get_project_graph(
    project_id: str,
    limit: int = Query(1200, ge=1, le=5000),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    _project_for_user(project_id, user)
    return ProjectScopedGraphClient(project_id).read_architecture_graph(limit=limit).model_dump()


@router.post("/projects/{project_id}/graph/nodes", status_code=201)
def create_graph_node(
    project_id: str,
    payload: NodeUpsertRequest,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    _project_for_user(project_id, user)
    client = ProjectScopedGraphClient(project_id)
    node = client.upsert_node(**payload.model_dump())
    return {
        "message": "node_saved",
        "node": node,
        "graph": client.read_architecture_graph(1500).model_dump(),
    }


@router.put("/projects/{project_id}/graph/nodes/{name}")
def update_graph_node(
    project_id: str,
    name: str,
    payload: NodeUpdateRequest,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    _project_for_user(project_id, user)
    client = ProjectScopedGraphClient(project_id)
    try:
        node = client.update_node_by_name(
            unquote(name), payload.model_dump(exclude_unset=True)
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "message": "node_updated",
        "node": node,
        "graph": client.read_architecture_graph(1500).model_dump(),
    }


@router.delete("/projects/{project_id}/graph/nodes/{name}")
def delete_graph_node(
    project_id: str,
    name: str,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    _project_for_user(project_id, user)
    client = ProjectScopedGraphClient(project_id)
    deleted = client.delete_node_by_name(unquote(name))
    return {"deleted": deleted, "graph": client.read_architecture_graph(1500).model_dump()}


@router.post("/projects/{project_id}/graph/edges", status_code=201)
def create_graph_edge(
    project_id: str,
    payload: EdgeUpsertRequest,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    _project_for_user(project_id, user)
    client = ProjectScopedGraphClient(project_id)
    edge = client.add_edge_by_names(
        payload.source, payload.target, payload.type, payload.description, payload.meta
    )
    return {
        "message": "edge_saved",
        "edge": edge,
        "graph": client.read_architecture_graph(1500).model_dump(),
    }


@router.put("/projects/{project_id}/graph/edges")
def update_graph_edge(
    project_id: str,
    payload: EdgeUpdateRequest,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    _project_for_user(project_id, user)
    if payload.source == payload.target:
        raise HTTPException(status_code=400, detail="关系的源节点和目标节点不能相同")
    client = ProjectScopedGraphClient(project_id)
    try:
        edge = client.update_edge_by_tuple(
            payload.original_source,
            payload.original_target,
            payload.original_type,
            payload.source,
            payload.target,
            payload.type,
            payload.description,
            payload.meta,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "message": "edge_updated",
        "edge": edge,
        "graph": client.read_architecture_graph(1500).model_dump(),
    }


@router.post("/projects/{project_id}/graph/edges/delete")
def delete_graph_edge(
    project_id: str,
    payload: EdgeDeleteRequest,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    _project_for_user(project_id, user)
    client = ProjectScopedGraphClient(project_id)
    deleted = client.delete_edge_by_tuple(payload.source, payload.target, payload.type)
    return {"deleted": deleted, "graph": client.read_architecture_graph(1500).model_dump()}


@router.post("/projects/{project_id}/graph/clear")
def clear_project_graph(
    project_id: str,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    _project_for_user(project_id, user)
    return {
        "message": "architecture_graph_cleared",
        **ProjectScopedGraphClient(project_id).clear_architecture_graph(),
    }


# Logs and RCA -------------------------------------------------------------


@router.get("/projects/{project_id}/logs")
def list_log_batches(
    project_id: str,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    _project_for_user(project_id, user, database)
    return {"items": [_batch_result(item) for item in database.list_log_batches(project_id)]}


def _load_details(output_dir: Path) -> list[dict[str, Any]]:
    path = output_dir / "incident_details.json"
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    if isinstance(data, dict):
        return [data]
    return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []


def _persist_incidents(
    database: SystemDatabase,
    project_id: str,
    batch_id: str,
    actor_id: str,
    details: list[dict[str, Any]],
    analyses: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_external: dict[str, dict[str, Any]] = {}
    for analysis in analyses:
        graph_id = str(analysis.get("incident_id") or "")
        external = graph_id.split(":", 1)[-1]
        by_external[external] = analysis

    saved: list[dict[str, Any]] = []
    for index, detail in enumerate(details, start=1):
        external = str(detail.get("incident_id") or f"I{index:05d}")
        analysis = by_external.get(external, {})
        hypotheses = analysis.get("hypotheses") or []
        top = hypotheses[0] if hypotheses else {}
        confidence = float(top.get("confidence") or 0)
        severity = "critical" if confidence >= 0.9 else "high" if confidence >= 0.75 else "medium" if confidence >= 0.5 else "low"
        root_service = str(detail.get("root_service_candidate") or "未知服务")
        root_cause = str(detail.get("root_cause_candidate") or "未提取到明确异常")
        graph_id = str(analysis.get("incident_id") or f"{batch_id[:12]}:{external}")
        item = database.upsert_incident(
            {
                "project_id": project_id,
                "log_batch_id": batch_id,
                "external_incident_id": external,
                "graph_incident_id": graph_id,
                "title": f"{root_service}：{root_cause[:100]}",
                "severity": severity,
                "root_candidate": str(top.get("candidate") or root_service),
                "root_confidence": confidence,
                "fault_mode": str(top.get("fault_mode") or ""),
                "chain_json": json.dumps(top.get("chain") or [], ensure_ascii=False),
                "analysis_json": json.dumps(analysis, ensure_ascii=False),
                "detail_json": json.dumps(detail, ensure_ascii=False),
            }
        )
        database.add_incident_action(str(item["id"]), actor_id, "detected", "日志分析自动创建")
        saved.append(_incident_result(item))
    return saved


@router.post("/projects/{project_id}/logs/analyze", status_code=201)
async def analyze_project_logs(
    project_id: str,
    file: UploadFile = File(...),
    train_file: UploadFile | None = File(None),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    _project_for_user(project_id, user, database)
    raw = await _read_upload(file)
    train_raw = await _read_upload(train_file) if train_file is not None else None

    batch_id = str(uuid.uuid4())
    work_dir = _data_dir(project_id, "logs", batch_id)
    input_path = work_dir / _clean_name(file.filename, "logs.zip")
    input_path.write_bytes(raw)
    train_path: Path | None = None
    if train_file is not None and train_raw is not None:
        train_path = work_dir / _clean_name(train_file.filename, "normal-train.zip")
        train_path.write_bytes(train_raw)
    output_dir = work_dir / "output"

    batch = database.create_log_batch(
        project_id,
        input_path.name,
        str(input_path),
        train_path.name if train_path else "",
        str(train_path) if train_path else "",
        str(output_dir),
        str(user["id"]),
        batch_id=batch_id,
    )
    try:
        runner = LogFaultRunner()
        summary = await run_in_threadpool(runner._run_pipeline, input_path, output_dir, train_path)
        scoped = ProjectScopedGraphClient(project_id)
        imported = await run_in_threadpool(
            IncidentGraphIntegrator(scoped).import_path,
            output_dir,
            input_path.name,
            batch_id[:12],
        )
        import_data = imported.model_dump()
        await run_in_threadpool(runner._write_rca_artifacts, output_dir, import_data.get("rca") or [])
        details = _load_details(output_dir)
        incidents = _persist_incidents(
            database,
            project_id,
            batch_id,
            str(user["id"]),
            details,
            import_data.get("rca") or [],
        )
        database.complete_log_batch(
            batch_id,
            json.dumps(summary, ensure_ascii=False),
            json.dumps(import_data.get("rca") or [], ensure_ascii=False),
        )
        completed = database.get_log_batch(batch_id) or batch
        return {
            "message": "log_analyzed",
            "batch": _batch_result(completed),
            "summary": summary,
            "incidents": incidents,
            "integration": {
                key: value for key, value in import_data.items() if key != "rca"
            },
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("Log analysis failed project=%s batch=%s", project_id, batch_id)
        database.fail_log_batch(batch_id, str(exc))
        raise HTTPException(status_code=500, detail=f"日志分析失败：{exc}") from exc


@router.get("/projects/{project_id}/logs/{batch_id}")
def get_log_batch(
    project_id: str,
    batch_id: str,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    _project_for_user(project_id, user, database)
    item = database.get_log_batch(batch_id)
    if not item or item.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="日志批次不存在")
    result = _batch_result(item)
    result["rca"] = _json(item.get("rca_json"), [])
    return {"batch": result}


@router.delete("/projects/{project_id}/logs/{batch_id}")
def delete_log_batch(
    project_id: str,
    batch_id: str,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    _project_for_user(project_id, user, database)
    batch = database.get_log_batch(batch_id)
    if not batch or batch.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="日志批次不存在")

    warnings: list[str] = []
    graph_cleanup: dict[str, int] = {}
    try:
        graph_cleanup = ProjectScopedGraphClient(project_id).delete_incident_batch(
            batch_id[:12]
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to clean graph for deleted batch=%s", batch_id)
        warnings.append(f"日志记录已删除，但图谱清理失败：{exc}")

    logs_root = (
        Path(get_settings().app_data_root).expanduser().resolve()
        / "projects"
        / project_id
        / "logs"
    ).resolve()
    batch_dir = Path(str(batch.get("input_path") or "")).expanduser().resolve().parent
    if (
        batch_dir.name == batch_id
        and batch_dir.is_relative_to(logs_root)
        and batch_dir.is_dir()
    ):
        shutil.rmtree(batch_dir)
    elif batch_dir.exists():
        raise HTTPException(status_code=500, detail="日志批次目录校验失败，未删除磁盘文件")

    if not database.delete_log_batch(batch_id):
        raise HTTPException(status_code=404, detail="日志批次不存在")
    return {
        "message": "log_batch_deleted",
        "deleted": True,
        "graph_cleanup": graph_cleanup,
        "warnings": warnings,
        "recoverable": False,
    }


@router.get("/projects/{project_id}/logs/{batch_id}/artifacts/{filename}")
def download_log_artifact(
    project_id: str,
    batch_id: str,
    filename: str,
    user: dict[str, Any] = Depends(require_user),
) -> FileResponse:
    database = get_system_db()
    _project_for_user(project_id, user, database)
    batch = database.get_log_batch(batch_id)
    if not batch or batch.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="日志批次不存在")
    allowed = {
        "summary.json",
        "incidents.csv",
        "incident_details.json",
        "root_cause_report.md",
        "kg_rca_report.md",
        "rca_results.json",
        "anomaly_windows.csv",
    }
    safe = Path(filename).name
    if safe not in allowed:
        raise HTTPException(status_code=404, detail="结果文件不存在")
    path = Path(str(batch["output_path"])) / safe
    if not path.is_file():
        raise HTTPException(status_code=404, detail="结果文件不存在")
    return FileResponse(path, filename=safe)


# Incidents ---------------------------------------------------------------


@router.get("/projects/{project_id}/incidents")
def list_incidents(
    project_id: str,
    incident_status: str = Query("", alias="status"),
    severity: str = Query(""),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    _project_for_user(project_id, user, database)
    valid_status = {"", "open", "in_progress", "resolved", "ignored"}
    valid_severity = {"", "low", "medium", "high", "critical"}
    if incident_status not in valid_status or severity not in valid_severity:
        raise HTTPException(status_code=400, detail="筛选条件无效")
    return {
        "items": [
            _incident_result(item)
            for item in database.list_incidents(project_id, incident_status, severity)
        ]
    }


@router.get("/projects/{project_id}/incidents/{incident_id}")
def get_incident(
    project_id: str,
    incident_id: str,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    item = _incident_for_user(project_id, incident_id, user, database)
    result = _incident_result(item, detailed=True)
    result["actions"] = database.list_incident_actions(incident_id)
    return {"incident": result}


@router.get("/projects/{project_id}/incidents/{incident_id}/graph")
def get_incident_fusion_graph(
    project_id: str,
    incident_id: str,
    include_events: bool = Query(False),
    event_limit: int = Query(30, ge=1, le=120),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    incident = _incident_for_user(project_id, incident_id, user, database)
    graph = ProjectScopedGraphClient(project_id).read_incident_graph(
        str(incident["graph_incident_id"]),
        include_events=include_events,
        event_limit=event_limit,
    )
    return {
        "incident_id": incident_id,
        "graph_incident_id": incident["graph_incident_id"],
        "include_events": include_events,
        "graph": graph.model_dump(),
    }


@router.patch("/projects/{project_id}/incidents/{incident_id}/status")
def change_incident_status(
    project_id: str,
    incident_id: str,
    payload: IncidentStatusRequest,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    _incident_for_user(project_id, incident_id, user, database)
    note = payload.resolution_note.strip()
    if payload.status == "resolved" and not note:
        raise HTTPException(status_code=400, detail="标记已解决时必须填写解决说明")
    updated = database.update_incident_status(
        incident_id, payload.status, note, str(user["id"])
    )
    result = _incident_result(updated, detailed=True)
    result["actions"] = database.list_incident_actions(incident_id)
    return {"message": "incident_status_updated", "incident": result}
