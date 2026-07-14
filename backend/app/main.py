from __future__ import annotations

import logging
import time

from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from .analyzer import LLMAnalyzer
from .config import get_settings
from .hugegraph_client import HugeGraphRestClient
from .models import GraphResponse
from .service import GraphBuilderService

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
logger = logging.getLogger("logsys-kg-demo")

app = FastAPI(title="LogSys Knowledge Graph Demo", version="5.0.0")
settings = get_settings()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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


@app.get("/api/graph", response_model=GraphResponse)
def get_graph(limit: int = 800) -> GraphResponse:
    # Page-load uses REST only and never calls /gremlin.
    try:
        client = HugeGraphRestClient()
        return client.read_graph(limit=max(1, min(limit, 5000)))
    except Exception as exc:  # noqa: BLE001
        return GraphResponse(nodes=[], edges=[], warnings=[str(exc)])


@app.post("/api/clear")
def clear_graph() -> dict:
    try:
        client = HugeGraphRestClient()
        return {"message": "cleared", **client.clear_logsys_graph()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc
