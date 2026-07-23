from __future__ import annotations

import logging
import time
from urllib.parse import unquote

from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from .analyzer import LLMAnalyzer
from .config import get_settings
from .hugegraph_client import HugeGraphRestClient
from .log_integration import IncidentGraphIntegrator, LogFaultRunner
from .models import EdgeDeleteRequest, EdgeUpsertRequest, GraphResponse, NodeUpdateRequest, NodeUpsertRequest
from .rca_engine import hypotheses_from_persisted_graph
from .service import GraphBuilderService
from .system_api import router as system_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
logger = logging.getLogger("logsys-kg-demo")

app = FastAPI(title="LogSys Knowledge Graph RCA System", version="8.0.0")
settings = get_settings()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    # Authentication uses an Authorization bearer token, not browser cookies.
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(system_router)


@app.middleware("http")
async def request_log_middleware(request: Request, call_next):
    start = time.time()
    logger.info("REQ START method=%s path=%s client=%s", request.method, request.url.path, request.client.host if request.client else "-")
    try:
        response = await call_next(request)
        elapsed = time.time() - start
        logger.info("REQ END method=%s path=%s status=%s elapsed=%.2fs", request.method, request.url.path, response.status_code, elapsed)
        return response
    except Exception:
        elapsed = time.time() - start
        logger.exception("REQ ERROR method=%s path=%s elapsed=%.2fs", request.method, request.url.path, elapsed)
        raise


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "llm_base_url": settings.llm_openai_base_url,
        "llm_model": settings.llm_model,
        "llm_api_key_is_blank": not bool(settings.llm_api_key),
        "llm_enabled": settings.llm_enabled,
        "llm_use_langchain_first": settings.llm_use_langchain_first,
        "llm_disable_env_proxy": settings.llm_disable_env_proxy,
        "rca_decision_model": {
            "enabled": settings.rca_decision_enabled,
            "url": settings.rca_decision_url,
            "model_config_id": settings.rca_decision_model_config_id,
            "assistant_role": settings.rca_decision_assistant_role,
            "assistant_name": settings.rca_decision_assistant_name,
        },
        "logfault": {
            "project_path": settings.logfault_project_path,
            "config_path": settings.logfault_config_path,
            "output_root": settings.logfault_output_root,
        },
        "rca": {"top_k": settings.rca_top_k},
        "hugegraph": {
            "host": settings.hugegraph_host,
            "port": settings.hugegraph_port,
            "graphspace": settings.hugegraph_graphspace,
            "graph": settings.hugegraph_graph,
            "node_label": settings.node_label,
            "edge_label": settings.edge_label,
        },
    }


@app.get("/api/debug/hugegraph")
def debug_hugegraph() -> dict:
    client = HugeGraphRestClient()
    return client.ping()


@app.get("/api/debug/llm")
def debug_llm() -> dict:
    try:
        analyzer = LLMAnalyzer()
        data = analyzer.analyze_architecture("系统包含订单服务和订单数据库。订单服务读写订单数据库。")
        return {"status": "ok", "mode": analyzer.last_mode, "logs": analyzer.last_logs, "data": data}
    except Exception as exc:  # noqa: BLE001
        return {"status": "failed", "error": str(exc)}


@app.post("/api/import")
async def import_file(file: UploadFile = File(...)) -> dict:
    logger.info("IMPORT START filename=%s content_type=%s", file.filename, file.content_type)
    try:
        raw = await file.read()
        logger.info("IMPORT FILE READ filename=%s bytes=%s", file.filename, len(raw))

        text = raw.decode("utf-8", errors="replace")
        logger.info("IMPORT TEXT DECODED filename=%s chars=%s", file.filename, len(text))

        service = GraphBuilderService()
        logger.info("IMPORT LLM+HUGEGRAPH START filename=%s", file.filename)
        data, logs = service.build_ontology_graph(text, source_file=file.filename or "")
        logger.info(
            "IMPORT LLM+HUGEGRAPH DONE filename=%s extracted_nodes=%s extracted_edges=%s",
            file.filename,
            len(data.get("services", [])),
            len(data.get("calls", [])),
        )

        graph = service.db.read_graph(limit=1000)
        logger.info("IMPORT READ GRAPH DONE filename=%s graph_nodes=%s graph_edges=%s", file.filename, len(graph.nodes), len(graph.edges))
        return {
            "message": "imported",
            "file": file.filename,
            "extracted_nodes": len(data.get("services", [])),
            "extracted_edges": len(data.get("calls", [])),
            "data": data,
            "logs": logs,
            "graph": graph.model_dump(),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("IMPORT FAILED filename=%s", file.filename)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/incidents/import")
async def import_incident_bundle(file: UploadFile = File(...)) -> dict:
    logger.info("INCIDENT IMPORT START filename=%s content_type=%s", file.filename, file.content_type)
    try:
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory(prefix="logsys-upload-incident-") as temp:
            path = Path(temp) / (file.filename or "incident_details.json")
            path.write_bytes(await file.read())
            result = IncidentGraphIntegrator().import_path(path, source_name=file.filename or "incident_upload")
            graph = HugeGraphRestClient().read_graph(limit=1500)
            return {"message": "incident_imported", **result.model_dump(), "graph": graph.model_dump()}
    except Exception as exc:  # noqa: BLE001
        logger.exception("INCIDENT IMPORT FAILED filename=%s", file.filename)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/logs/analyze")
async def analyze_logs(file: UploadFile = File(...), train_file: UploadFile | None = File(None)) -> dict:
    logger.info("LOG ANALYZE START filename=%s train=%s", file.filename, train_file.filename if train_file else "-")
    try:
        result = await LogFaultRunner().analyze_upload(file=file, train_file=train_file)
        graph = HugeGraphRestClient().read_graph(limit=1500)
        return {"message": "log_analyzed", **result, "graph": graph.model_dump()}
    except Exception as exc:  # noqa: BLE001
        logger.exception("LOG ANALYZE FAILED filename=%s", file.filename)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/graph", response_model=GraphResponse)
def get_graph(limit: int = 800) -> GraphResponse:
    try:
        client = HugeGraphRestClient()
        return client.read_graph(limit=max(1, min(limit, 5000)))
    except Exception as exc:  # noqa: BLE001
        return GraphResponse(nodes=[], edges=[], warnings=[str(exc)])


@app.get("/api/incidents/{incident_id}/rca")
def get_incident_rca(incident_id: str) -> dict:
    """Return ranked, persisted RCA hypotheses without rerunning log analysis."""
    try:
        client = HugeGraphRestClient()
        graph = client.read_graph(limit=5000)
        hypotheses = hypotheses_from_persisted_graph(graph, unquote(incident_id))
        if not hypotheses:
            raise HTTPException(status_code=404, detail=f"未找到故障 {incident_id} 的 RCA 结果")
        return {"incident_id": unquote(incident_id), "hypotheses": hypotheses}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/nodes")
def upsert_node(payload: NodeUpsertRequest) -> dict:
    try:
        client = HugeGraphRestClient()
        result = client.upsert_node(**payload.model_dump())
        return {"message": "node_saved", "node": result, "graph": client.read_graph(limit=1200).model_dump()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.put("/api/nodes/{name}")
def update_node(name: str, payload: NodeUpdateRequest) -> dict:
    try:
        client = HugeGraphRestClient()
        result = client.update_node_by_name(unquote(name), payload.model_dump(exclude_unset=True))
        return {"message": "node_updated", "node": result, "graph": client.read_graph(limit=1200).model_dump()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.delete("/api/nodes/{name}")
def delete_node(name: str) -> dict:
    try:
        client = HugeGraphRestClient()
        deleted = client.delete_node_by_name(unquote(name))
        return {"message": "node_deleted" if deleted else "node_not_found", "deleted": deleted, "graph": client.read_graph(limit=1200).model_dump()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/edges")
def upsert_edge(payload: EdgeUpsertRequest) -> dict:
    try:
        client = HugeGraphRestClient()
        result = client.add_edge_by_names(payload.source, payload.target, payload.type, payload.description, payload.meta)
        return {"message": "edge_saved", "edge": result, "graph": client.read_graph(limit=1200).model_dump()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/edges/delete")
def delete_edge(payload: EdgeDeleteRequest) -> dict:
    try:
        client = HugeGraphRestClient()
        deleted = client.delete_edge_by_tuple(payload.source, payload.target, payload.type)
        return {"message": "edge_deleted" if deleted else "edge_not_found", "deleted": deleted, "graph": client.read_graph(limit=1200).model_dump()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/clear")
def clear_graph() -> dict:
    try:
        client = HugeGraphRestClient()
        return {"message": "cleared", **client.clear_logsys_graph()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc
