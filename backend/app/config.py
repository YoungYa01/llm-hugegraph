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


@dataclass(frozen=True)
class Settings:
    # Local LLM. This remains compatible with the user's test.py style:
    # OpenAI-compatible /v1/chat/completions first, llama.cpp /completion fallback.
    llm_enabled: bool = _bool_env("LLM_ENABLED", True)
    llm_base_url: str = _env("LLM_BASE_URL", "http://127.0.0.1:1234")
    llm_model: str = _env("LLM_MODEL", "Qwen_Qwen3_14B_Q4_K_M")
    llm_api_key: str = _env("LLM_API_KEY", "not-needed")
    llm_timeout_seconds: int = _int_env("LLM_TIMEOUT_SECONDS", 180)
    llm_connect_timeout_seconds: int = _int_env("LLM_CONNECT_TIMEOUT_SECONDS", 10)
    llm_max_tokens: int = _int_env("LLM_MAX_TOKENS", 2048)
    llm_chunk_chars: int = _int_env("LLM_CHUNK_CHARS", 700)
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
    node_label: str = _env("HUGEGRAPH_NODE_LABEL", "LogSysKGNodeV6")
    edge_label: str = _env("HUGEGRAPH_EDGE_LABEL", "LOGSYS_KG_RELATION_V6")


    # Optional integration with the v1-goat sliding-window logfault package.
    logfault_project_path: str = _env("LOGFAULT_PROJECT_PATH", "")
    logfault_config_path: str = _env("LOGFAULT_CONFIG_PATH", "")
    logfault_output_root: str = _env("LOGFAULT_OUTPUT_ROOT", "./runs/kg")
    incident_timeline_limit: int = _int_env("INCIDENT_TIMELINE_LIMIT", 120)

    @property
    def llm_openai_base_url(self) -> str:
        return normalize_openai_base_url(self.llm_base_url)


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
