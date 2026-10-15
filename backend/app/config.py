from __future__ import annotations

import os
from dataclasses import dataclass

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover
    load_dotenv = None

if load_dotenv:
    load_dotenv()


def _env(name: str, default: str) -> str:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip()


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def normalize_openai_base_url(url: str) -> str:
    url = url.rstrip("/")
    return url if url.endswith("/v1") else f"{url}/v1"


def normalize_llm_provider(value: str) -> str:
    provider = str(value or "").strip().lower().replace("_", "-")
    aliases = {
        "company": "company",
        "openai": "openai",
        "openai-compatible": "openai",
        "llamacpp": "llamacpp",
        "llama.cpp": "llamacpp",
        "llama-cpp": "llamacpp",
    }
    if provider not in aliases:
        raise ValueError(
            f"Unsupported LLM_PROVIDER={value!r}; expected company, openai, or llamacpp"
        )
    return aliases[provider]


@dataclass(frozen=True)
class Settings:
    # Application system storage and authentication.
    app_data_root: str = _env("APP_DATA_ROOT", "./data")
    app_database_path: str = _env("APP_DATABASE_PATH", "./data/logsys.db")
    session_expire_hours: int = _int_env("SESSION_EXPIRE_HOURS", 24)
    allow_registration: bool = _bool_env("ALLOW_REGISTRATION", True)
    max_upload_mb: int = _int_env("MAX_UPLOAD_MB", 200)

    # One provider is selected for every LLM call in the application.  We do
    # not silently fall through to a different protocol because that can send
    # the same prompt to an unintended service.
    llm_enabled: bool = _bool_env("LLM_ENABLED", True)
    llm_provider: str = _env("LLM_PROVIDER", "openai").lower()
    llm_base_url: str = _env("LLM_BASE_URL", "http://127.0.0.1:1234")
    llm_model: str = _env("LLM_MODEL", "qwen3.5_14B_Q4_K_M")
    llm_api_key: str = _env("LLM_API_KEY", "not-needed")
    llm_timeout_seconds: int = _int_env("LLM_TIMEOUT_SECONDS", 180)
    llm_connect_timeout_seconds: int = _int_env("LLM_CONNECT_TIMEOUT_SECONDS", 10)
    llm_max_tokens: int = _int_env("LLM_MAX_TOKENS", 2048)
    llm_chunk_chars: int = _int_env("LLM_CHUNK_CHARS", 700)
    llm_max_workers: int = _int_env("LLM_MAX_WORKERS", 4)
    llm_disable_thinking: bool = _bool_env("LLM_DISABLE_THINKING", True)
    # Default false: avoids LangChain/httpx proxy/credential surprises. Direct HTTP
    # is the same OpenAI-compatible protocol used by the reference project/server.
    llm_use_langchain_first: bool = _bool_env("LLM_USE_LANGCHAIN_FIRST", False)
    llm_disable_env_proxy: bool = _bool_env("LLM_DISABLE_ENV_PROXY", True)

    # HugeGraph REST. The client auto-detects both 1.7 graphspace URL and legacy URL.
    hugegraph_host: str = _env("HUGEGRAPH_HOST", "127.0.0.1")
    hugegraph_port: int = _int_env("HUGEGRAPH_PORT", 8080)
    hugegraph_graphspace: str = _env("HUGEGRAPH_GRAPHSPACE", "DEFAULT")
    hugegraph_graph: str = _env("HUGEGRAPH_GRAPH", "hugegraph")
    hugegraph_timeout_seconds: int = _int_env("HUGEGRAPH_TIMEOUT_SECONDS", 30)

    # Versioned schema names avoid collisions with earlier broken local attempts.
    node_label: str = _env("HUGEGRAPH_NODE_LABEL", "LogSysKGNodeV7")
    edge_label: str = _env("HUGEGRAPH_EDGE_LABEL", "LOGSYS_KG_RELATION_V7")

    # Optional integration with the v1-goat sliding-window logfault package.
    logfault_project_path: str = _env("LOGFAULT_PROJECT_PATH", "")
    logfault_config_path: str = _env("LOGFAULT_CONFIG_PATH", "")
    logfault_output_root: str = _env("LOGFAULT_OUTPUT_ROOT", "./runs/kg")
    incident_timeline_limit: int = _int_env("INCIDENT_TIMELINE_LIMIT", 120)
    rca_top_k: int = _int_env("RCA_TOP_K", 5)

    # RCA graph pruning: keep only evidence and topology relevant to the incident.
    rca_graph_pruning_enabled: bool = _bool_env("RCA_GRAPH_PRUNING_ENABLED", True)
    rca_graph_max_events: int = _int_env("RCA_GRAPH_MAX_EVENTS", 24)
    rca_graph_context_radius: int = _int_env("RCA_GRAPH_CONTEXT_RADIUS", 1)
    rca_graph_max_events_per_pattern: int = _int_env("RCA_GRAPH_MAX_EVENTS_PER_PATTERN", 2)
    rca_graph_max_root_candidates: int = _int_env("RCA_GRAPH_MAX_ROOT_CANDIDATES", 3)
    rca_graph_max_hypotheses: int = _int_env("RCA_GRAPH_MAX_HYPOTHESES", 3)
    rca_graph_max_exceptions: int = _int_env("RCA_GRAPH_MAX_EXCEPTIONS", 3)
    rca_graph_write_unresolved_services: bool = _bool_env("RCA_GRAPH_WRITE_UNRESOLVED_SERVICES", False)
    rca_graph_write_cooccurrence_edges: bool = _bool_env("RCA_GRAPH_WRITE_COOCCURRENCE_EDGES", False)
    rca_graph_write_temporal_edges: bool = _bool_env("RCA_GRAPH_WRITE_TEMPORAL_EDGES", True)

    # Deterministic log compression before the final RCA decision LLM call.
    # max_chars is a hard budget for the compressed log-context JSON only.
    log_compression_enabled: bool = _bool_env("LOG_COMPRESSION_ENABLED", True)
    log_compression_max_chars: int = _int_env("LOG_COMPRESSION_MAX_CHARS", 6000)
    log_compression_max_events: int = _int_env("LOG_COMPRESSION_MAX_EVENTS", 16)
    log_compression_context_radius: int = _int_env("LOG_COMPRESSION_CONTEXT_RADIUS", 2)
    log_compression_max_patterns: int = _int_env("LOG_COMPRESSION_MAX_PATTERNS", 6)
    log_compression_max_message_chars: int = _int_env("LOG_COMPRESSION_MAX_MESSAGE_CHARS", 300)

    # Whether RCA should use the provider selected by LLM_PROVIDER after the
    # deterministic hypothesis list has been generated.
    rca_decision_enabled: bool = _bool_env("RCA_DECISION_ENABLED", True)
    rca_llm_max_tokens: int = _int_env("RCA_LLM_MAX_TOKENS", 2048)
    rca_prompt_architecture_radius: int = _int_env("RCA_PROMPT_ARCHITECTURE_RADIUS", 2)
    rca_prompt_architecture_max_nodes: int = _int_env("RCA_PROMPT_ARCHITECTURE_MAX_NODES", 20)
    rca_prompt_architecture_max_seeds: int = _int_env("RCA_PROMPT_ARCHITECTURE_MAX_SEEDS", 3)
    rca_prompt_max_hypotheses: int = _int_env("RCA_PROMPT_MAX_HYPOTHESES", 3)
    rca_decision_max_workers: int = _int_env("RCA_DECISION_MAX_WORKERS", 3)
    rca_decision_isolate_conversations: bool = _bool_env(
        "RCA_DECISION_ISOLATE_CONVERSATIONS",
        True,
    )

    # Company /api/conversation protocol.  The old RCA_DECISION_* names remain
    # as fallbacks so existing deployments continue to work while migrating to
    # the clearer COMPANY_LLM_* names.
    company_llm_url: str = _env(
        "COMPANY_LLM_URL",
        _env("RCA_DECISION_URL", "http://127.0.0.1/api/conversation"),
    )
    company_llm_model_config_id: str = _env(
        "COMPANY_LLM_MODEL_CONFIG_ID",
        _env("RCA_DECISION_MODEL_CONFIG_ID", ""),
    )
    company_llm_assistant_role: str = _env(
        "COMPANY_LLM_ASSISTANT_ROLE",
        _env("RCA_DECISION_ASSISTANT_ROLE", "general"),
    )
    company_llm_assistant_name: str = _env(
        "COMPANY_LLM_ASSISTANT_NAME",
        _env("RCA_DECISION_ASSISTANT_NAME", "normal_assistant"),
    )
    company_llm_assistant_prompt: str = _env(
        "COMPANY_LLM_ASSISTANT_PROMPT",
        "你是日志系统的大模型助手。严格遵守用户提示，并只返回要求的结果格式。",
    )
    company_llm_stream: bool = _bool_env(
        "COMPANY_LLM_STREAM",
        _bool_env("RCA_DECISION_STREAM", False),
    )
    company_llm_code_language: str = _env(
        "COMPANY_LLM_CODE_LANGUAGE",
        _env("RCA_DECISION_CODE_LANGUAGE", ""),
    )
    company_llm_kb_id: str = _env(
        "COMPANY_LLM_KB_ID",
        _env("RCA_DECISION_KB_ID", ""),
    )
    company_llm_kb_name: str = _env(
        "COMPANY_LLM_KB_NAME",
        _env("RCA_DECISION_KB_NAME", ""),
    )
    company_llm_timeout_seconds: int = _int_env(
        "COMPANY_LLM_TIMEOUT_SECONDS",
        _int_env("RCA_DECISION_TIMEOUT_SECONDS", 90),
    )
    company_llm_connect_timeout_seconds: int = _int_env(
        "COMPANY_LLM_CONNECT_TIMEOUT_SECONDS",
        _int_env("RCA_DECISION_CONNECT_TIMEOUT_SECONDS", 10),
    )

    # Deprecated compatibility fields.  New code reads COMPANY_LLM_* above.
    rca_decision_url: str = _env("RCA_DECISION_URL", "http://127.0.0.1/api/conversation")
    rca_decision_model_config_id: str = _env("RCA_DECISION_MODEL_CONFIG_ID", "")
    rca_decision_assistant_role: str = _env("RCA_DECISION_ASSISTANT_ROLE", "general")
    rca_decision_assistant_name: str = _env("RCA_DECISION_ASSISTANT_NAME", "normal_assistant")
    rca_decision_assistant_prompt: str = _env("RCA_DECISION_ASSISTANT_PROMPT", "")
    rca_decision_stream: bool = _bool_env("RCA_DECISION_STREAM", False)
    rca_decision_code_language: str = _env("RCA_DECISION_CODE_LANGUAGE", "")
    rca_decision_kb_id: str = _env("RCA_DECISION_KB_ID", "")
    rca_decision_kb_name: str = _env("RCA_DECISION_KB_NAME", "")
    rca_decision_timeout_seconds: int = _int_env("RCA_DECISION_TIMEOUT_SECONDS", 90)
    rca_decision_connect_timeout_seconds: int = _int_env("RCA_DECISION_CONNECT_TIMEOUT_SECONDS", 10)

    @property
    def llm_openai_base_url(self) -> str:
        return normalize_openai_base_url(self.llm_base_url)


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
