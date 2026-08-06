from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile, status
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
from pydantic import BaseModel, Field
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
    if not project or (user.get("role") != "admin" and project.get("owner_id") != user.get("id")):
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
    return dict(project)


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
    # severity_dist 和 resolved_count 由 list_log_batches 附加，直接透传
    # （get_log_batch 单条查询无聚合时给出空默认值，保持兼容）
    result.setdefault("severity_dist", {"critical": 0, "high": 0, "medium": 0, "low": 0})
    result.setdefault("resolved_count", 0)
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
    employee_id = payload.employee_id.strip()
    if not employee_id:
        raise HTTPException(status_code=422, detail="工号不能为空")
    try:
        user = database.create_user(
            payload.username.strip(),
            hash_password(payload.password),
            payload.display_name.strip(),
            employee_id,
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
    del include_archived
    items = get_system_db().list_projects_for_user(user)
    return {"items": [_public_project(item) for item in items]}


@router.get("/users")
def list_users(
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="仅系统管理员有权查看所有用户")
    database = get_system_db()
    return {"items": database.list_all_users()}


class ProfileUpdateRequest(BaseModel):
    display_name: str = Field("", max_length=120)
    employee_id: str | None = Field(None, max_length=64)
    old_password: str = Field("", max_length=120)
    new_password: str = Field("", max_length=120)


@router.patch("/auth/profile")
def update_own_profile(
    payload: ProfileUpdateRequest,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    user_id = str(user["id"])
    
    new_hash = None
    if payload.new_password.strip():
        if not payload.old_password:
            raise HTTPException(status_code=400, detail="修改密码时必须输入当前旧密码")
        if not verify_password(payload.old_password, str(user.get("password_hash") or "")):
            raise HTTPException(status_code=400, detail="旧密码验证错误")
        if len(payload.new_password.strip()) < 4:
            raise HTTPException(status_code=400, detail="新密码至少包含4位字符")
        new_hash = hash_password(payload.new_password.strip())

    display_name = payload.display_name.strip() if payload.display_name.strip() else None
    employee_id = payload.employee_id.strip() if payload.employee_id is not None else None
    if payload.employee_id is not None and not employee_id:
        raise HTTPException(status_code=400, detail="工号不能为空")

    updated = database.update_user_profile(
        user_id,
        display_name=display_name,
        employee_id=employee_id,
        password_hash=new_hash,
    )
    return {"user": public_user(updated or user)}


class AdminUserUpdateRequest(BaseModel):
    display_name: str = Field("", max_length=120)
    employee_id: str | None = Field(None, max_length=64)
    role: str = Field("user", max_length=20)
    is_active: int = Field(1)
    new_password: str = Field("", max_length=120)


@router.patch("/users/{user_id}")
def update_user(
    user_id: str,
    payload: AdminUserUpdateRequest,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="仅系统管理员有权管理用户账号")
    
    database = get_system_db()
    target_user = database.query_one("SELECT * FROM users WHERE id = ?", (user_id,))
    if not target_user:
        raise HTTPException(status_code=404, detail="目标用户不存在")

    # 安全拦截：管理员账号不允许被停用
    if (target_user.get("role") == "admin" or payload.role == "admin") and payload.is_active == 0:
        raise HTTPException(status_code=400, detail="出于安全保护，系统管理员账号不可被停用")

    if user_id == str(user["id"]) and payload.role != "admin":
        raise HTTPException(status_code=400, detail="出于安全保护，不能降级您自己的管理员权限")

    new_hash = None
    if payload.new_password.strip():
        if len(payload.new_password.strip()) < 4:
            raise HTTPException(status_code=400, detail="新密码至少包含4位字符")
        new_hash = hash_password(payload.new_password.strip())

    display_name = payload.display_name.strip() if payload.display_name.strip() else None
    employee_id = payload.employee_id.strip() if payload.employee_id is not None else None
    if payload.employee_id is not None and not employee_id:
        raise HTTPException(status_code=400, detail="工号不能为空")

    updated = database.update_user_profile(
        user_id,
        display_name=display_name,
        employee_id=employee_id,
        role=payload.role,
        is_active=payload.is_active,
        password_hash=new_hash,
    )
    return {"user": public_user(updated or target_user)}


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
def delete_project(
    project_id: str,
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    _project_for_user(project_id, user, database)

    # 1. 异步清理 HugeGraph 图数据库中属于该项目的静态架构节点与动态日志/故障节点
    background_tasks.add_task(
        ProjectScopedGraphClient(project_id).clear_project_graph
    )

    # 2. 物理删除 SQLite 系统数据库中的项目及级联关联数据
    success = database.delete_project(project_id)
    if not success:
        raise HTTPException(status_code=404, detail="项目不存在或已被删除")

    # 3. 彻底物理删除该项目在磁盘 backend/data/projects/<project_id> 中的所有架构、日志与 RCA 文件目录
    project_dir = Path(get_settings().app_data_root) / "projects" / project_id
    if project_dir.exists():
        try:
            shutil.rmtree(project_dir, ignore_errors=True)
        except Exception as exc:
            logger.warning(f"物理删除项目磁盘目录 {project_dir} 异常: {exc}")

    return {"message": "project_deleted", "project_id": project_id}


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


async def _run_architecture_import_task(
    item_id: str,
    project_id: str,
    text: str,
    filename: str,
    employee_id: str,
) -> None:
    database = get_system_db()
    scoped = ProjectScopedGraphClient(project_id)

    def _on_progress(pct: int, msg: str) -> None:
        database.update_architecture_progress(item_id, pct, msg)

    try:
        _on_progress(10, "启动 LLM 大模型抽取引擎...")
        builder = GraphBuilderService(scoped, employee_id=employee_id)
        extracted, logs = await run_in_threadpool(
            builder.build_ontology_graph,
            text,
            filename,
            progress_callback=_on_progress,
        )
        _on_progress(92, "正在从 HugeGraph 读取最新架构拓扑快照...")
        graph = await run_in_threadpool(scoped.read_architecture_graph, 3000)
        database.complete_architecture_import(
            item_id,
            len(extracted.get("services") or []),
            len(extracted.get("calls") or []),
            json.dumps(logs, ensure_ascii=False),
            json.dumps(graph.model_dump(), ensure_ascii=False),
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Architecture import task failed project=%s item_id=%s", project_id, item_id)
        database.fail_architecture_import(item_id, str(exc))


@router.post("/projects/{project_id}/architectures/import", status_code=202)
async def import_architecture(
    project_id: str,
    file: UploadFile = File(...),
    name: str = Form(""),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    _project_for_user(project_id, user, database)
    employee_id = str(user.get("employee_id") or "").strip()
    if not employee_id:
        raise HTTPException(status_code=400, detail="当前账号未设置工号，请先在个人账号设置中补充")
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
    asyncio.create_task(
        _run_architecture_import_task(
            str(item["id"]),
            project_id,
            text,
            filename,
            employee_id,
        )
    )
    return {
        "message": "architecture_import_started",
        "task_id": str(item["id"]),
        "architecture": _architecture_result(item),
        "status": "processing",
        "progress": 5,
        "progress_message": "文件已接收，准备大模型抽取...",
    }


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


@router.put("/projects/{project_id}/graph/nodes/{name:path}")
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


@router.delete("/projects/{project_id}/graph/nodes/{name:path}")
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


@router.get("/projects/{project_id}/graph/export")
def export_architecture_graph(
    project_id: str,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    _project_for_user(project_id, user)
    client = ProjectScopedGraphClient(project_id)
    graph = client.read_architecture_graph(5000)
    return {
        "project_id": project_id,
        "nodes": [
            {
                "name": n.name,
                "layer": n.layer,
                "kind": n.kind,
                "description": n.description,
                "source_file": n.source_file,
                "meta": n.meta,
            }
            for n in graph.nodes
        ],
        "edges": [
            {
                "source": e.source,
                "target": e.target,
                "type": e.type,
                "description": e.description,
                "meta": e.meta,
            }
            for e in getattr(graph, "edges", [])
        ],
    }


@router.post("/projects/{project_id}/graph/import")
def import_architecture_graph_data(
    project_id: str,
    payload: dict[str, Any],
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    _project_for_user(project_id, user)
    client = ProjectScopedGraphClient(project_id)

    # 直接保存节点与依赖边，跳过大模型抽出步
    raw_nodes = payload.get("nodes") or []
    raw_edges = payload.get("edges") or []

    imported_nodes = 0
    imported_edges = 0

    for n in raw_nodes:
        name = str(n.get("name") or "").strip()
        if name:
            client.upsert_node(
                name=name,
                layer=str(n.get("layer") or "Component层"),
                kind=str(n.get("kind") or "Component"),
                description=str(n.get("description") or ""),
                source_file=str(n.get("source_file") or "manual_import"),
                meta=n.get("meta") if isinstance(n.get("meta"), dict) else {},
            )
            imported_nodes += 1

    for e in raw_edges:
        src = str(e.get("source") or "").strip()
        tgt = str(e.get("target") or "").strip()
        rel = str(e.get("type") or "CALLS").strip()
        if src and tgt:
            client.add_edge_by_names(
                source_name=src,
                target_name=tgt,
                relation_type=rel,
                description=str(e.get("description") or ""),
                meta=e.get("meta") if isinstance(e.get("meta"), dict) else {},
            )
            imported_edges += 1

    return {
        "message": "architecture_graph_imported",
        "imported_nodes": imported_nodes,
        "imported_edges": imported_edges,
        "graph": client.read_architecture_graph(1500).model_dump(),
    }


@router.post("/projects/{project_id}/graph/nodes/batch-delete")
def batch_delete_graph_nodes(
    project_id: str,
    payload: dict[str, Any],
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    _project_for_user(project_id, user)
    client = ProjectScopedGraphClient(project_id)
    names = payload.get("names") or []
    res = client.batch_delete_nodes(names)
    return {
        "message": "batch_nodes_deleted",
        **res,
        "graph": client.read_architecture_graph(1500).model_dump(),
    }


@router.post("/projects/{project_id}/graph/edges/batch-delete")
def batch_delete_graph_edges(
    project_id: str,
    payload: dict[str, Any],
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    _project_for_user(project_id, user)
    client = ProjectScopedGraphClient(project_id)
    edges = payload.get("edges") or []
    res = client.batch_delete_edges(edges)
    return {
        "message": "batch_edges_deleted",
        **res,
        "graph": client.read_architecture_graph(1500).model_dump(),
    }


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
        decision = analysis.get("llm_decision") if isinstance(analysis.get("llm_decision"), dict) else {}
        model_path = [
            str(item.get("node") or "").strip()
            for item in (decision.get("propagation_path") or decision.get("display_chain") or [])
            if isinstance(item, dict) and str(item.get("node") or "").strip()
        ]
        model_grounded = bool(
            str(decision.get("source") or "").lower() == "llm"
            and decision.get("selected_node_id")
            and model_path
        )
        confidence = float(
            decision.get("confidence") if model_grounded and decision.get("confidence") is not None
            else top.get("confidence") or 0
        )
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
                "root_candidate": str(
                    decision.get("selected_candidate") if model_grounded
                    else top.get("candidate") or root_service
                ),
                "root_confidence": confidence,
                "fault_mode": str(
                    decision.get("selected_fault_mode") if model_grounded
                    else top.get("fault_mode") or ""
                ),
                "chain_json": json.dumps(model_path if model_grounded else top.get("chain") or [], ensure_ascii=False),
                "analysis_json": json.dumps(analysis, ensure_ascii=False),
                "detail_json": json.dumps(detail, ensure_ascii=False),
            }
        )
        database.add_incident_action(str(item["id"]), actor_id, "detected", "日志分析自动创建")
        saved.append(_incident_result(item))
    return saved


async def _run_log_analysis_task(
    batch_id: str,
    project_id: str,
    user_id: str,
    employee_id: str,
    input_path: Path,
    output_dir: Path,
    train_path: Path | None,
    total_t0: float,
) -> None:
    database = get_system_db()
    try:
        database.update_log_batch_progress(batch_id, 20, "正在进行日志结构化解析与滑动窗口异常挖掘...")
        runner = LogFaultRunner()
        summary = await run_in_threadpool(runner._run_pipeline, input_path, output_dir, train_path)

        database.update_log_batch_progress(batch_id, 65, "正在结合 HugeGraph 拓扑做图谱 RCA 根因推理...")
        scoped = ProjectScopedGraphClient(project_id)
        imported = await run_in_threadpool(
            IncidentGraphIntegrator(scoped, employee_id=employee_id).import_path,
            output_dir,
            input_path.name,
            batch_id[:12],
        )
        import_data = imported.model_dump()

        database.update_log_batch_progress(batch_id, 88, "持久化故障事件与 RCA 诊断结论...")
        await run_in_threadpool(runner._write_rca_artifacts, output_dir, import_data.get("rca") or [])
        details = _load_details(output_dir)
        _persist_incidents(
            database,
            project_id,
            batch_id,
            user_id,
            details,
            import_data.get("rca") or [],
        )

        total_duration = round(time.perf_counter() - total_t0, 2)
        if isinstance(summary, dict):
            summary["duration_seconds"] = total_duration

        database.complete_log_batch(
            batch_id,
            json.dumps(summary, ensure_ascii=False),
            json.dumps(import_data.get("rca") or [], ensure_ascii=False),
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Log analysis task failed project=%s batch=%s", project_id, batch_id)
        database.fail_log_batch(batch_id, str(exc))


@router.post("/projects/{project_id}/logs/analyze", status_code=202)
async def analyze_project_logs(
    project_id: str,
    file: UploadFile = File(...),
    train_file: UploadFile | None = File(None),
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    total_t0 = time.perf_counter()
    database = get_system_db()
    _project_for_user(project_id, user, database)
    employee_id = str(user.get("employee_id") or "").strip()
    if not employee_id:
        raise HTTPException(status_code=400, detail="当前账号未设置工号，请先在个人账号设置中补充")
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
    asyncio.create_task(
        _run_log_analysis_task(
            batch_id,
            project_id,
            str(user["id"]),
            employee_id,
            input_path,
            output_dir,
            train_path,
            total_t0,
        )
    )
    return {
        "message": "log_analysis_started",
        "task_id": batch_id,
        "batch": _batch_result(batch),
        "status": "processing",
        "progress": 5,
        "progress_message": "日志包接收完成，准备执行分析...",
    }


@router.get("/projects/{project_id}/tasks/active")
def get_active_tasks(
    project_id: str,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    _project_for_user(project_id, user, database)
    tasks = database.get_active_tasks(project_id)
    return {"active_tasks": tasks}


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


def _clean_batch_disk_files(project_id: str, batch_id: str, batch: dict[str, Any] | None = None) -> None:
    """彻底物理清除日志批次对应的所有磁盘文件与目录。"""
    try:
        settings = get_settings()
        root_path = getattr(settings, "app_data_root", None) or getattr(settings, "data_dir", None)
        if not root_path:
            return
        data_dir = Path(root_path).expanduser().resolve()
        logs_root = data_dir / "projects" / project_id / "logs"

        # 1. 直接删除专属子目录 projects/<project_id>/logs/<batch_id>/
        batch_dir = logs_root / batch_id
        if batch_dir.exists():
            if batch_dir.is_dir():
                shutil.rmtree(batch_dir, ignore_errors=True)
            else:
                batch_dir.unlink(missing_ok=True)

        # 2. 如果批次对象里记录了具体的 input_path, output_path 或 train_path
        if batch:
            for key in ("input_path", "output_path", "train_path"):
                raw = batch.get(key)
                if not raw:
                    continue
                p = Path(str(raw)).expanduser().resolve()
                if p.exists():
                    if p.is_dir():
                        shutil.rmtree(p, ignore_errors=True)
                    else:
                        p.unlink(missing_ok=True)
                        if p.parent.exists() and p.parent != logs_root and p.parent.is_relative_to(logs_root):
                            try:
                                if not any(p.parent.iterdir()):
                                    shutil.rmtree(p.parent, ignore_errors=True)
                            except Exception:
                                pass
    except Exception as exc:  # noqa: BLE001
        logger.warning("清理日志批次磁盘文件异常 batch=%s: %s", batch_id, exc)


def _async_clean_batch_resources(project_id: str, batch_id: str, batch: dict[str, Any], app_data_root: str) -> None:
    """在后台异步擦除 HugeGraph 图数据库中的 300+ 节点及残余磁盘文件，带 3 次重试防护。"""
    del app_data_root
    max_retries = 3
    for attempt in range(1, max_retries + 1):
        try:
            res = ProjectScopedGraphClient(project_id).delete_incident_batch(batch_id[:12])
            logger.info("Async graph cleanup success for batch=%s (attempt %d): %s", batch_id, attempt, res)
            break
        except Exception as exc:  # noqa: BLE001
            logger.warning("Async graph cleanup attempt %d/%d failed for batch=%s: %s", attempt, max_retries, batch_id, exc)
            if attempt < max_retries:
                time.sleep(2 * attempt)

    _clean_batch_disk_files(project_id, batch_id, batch)


@router.delete("/projects/{project_id}/logs/{batch_id}")
def delete_log_batch(
    project_id: str,
    batch_id: str,
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    database = get_system_db()
    _project_for_user(project_id, user, database)
    batch = database.get_log_batch(batch_id)
    if not batch or batch.get("project_id") != project_id:
        # 即便数据库记录已不在，也强制尝试清理磁盘
        _clean_batch_disk_files(project_id, batch_id, None)
        return {
            "message": "log_batch_deleted",
            "deleted": True,
            "graph_cleanup": {},
            "warnings": [],
            "recoverable": False,
        }

    # 1. 立即同步从磁盘擦除对应的 logs/<batch_id> 文件夹与日志文件
    _clean_batch_disk_files(project_id, batch_id, batch)

    # 2. 在 SQLite 数据库中完成记录擦除
    database.delete_log_batch(batch_id)

    # 3. 将 HugeGraph 图节点 REST 清理异步移交给后台 BackgroundTasks 任务
    settings = get_settings()
    root_str = str(getattr(settings, "app_data_root", None) or getattr(settings, "data_dir", ""))
    background_tasks.add_task(
        _async_clean_batch_resources,
        project_id,
        batch_id,
        batch,
        root_str,
    )

    # 3. 毫秒级直接响应 HTTP 200 返回前端，彻底消除悬停“删除中...”
    return {
        "message": "log_batch_deleted",
        "deleted": True,
        "graph_cleanup": {"async": True},
        "warnings": [],
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
