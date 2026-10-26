from __future__ import annotations

"""LLM 结构化日志抽取（主线 B）：替代 `_signals` 的关键词判断与 `_exception_details` 的正则抽取。

设计目标（对齐 rcs-fix-plan.md 四、主线 B）：

1. 一次 LLM 调用，把一条报错日志抽成受 schema 约束的结构：
   - template   : 语义模板（变量用命名占位符，而非正则打码）
   - parameters : 命名的变量值
   - resource   : 涉及的资源实体，并映射到架构图节点（本体约束）
   - fault      : 故障类型 + 证据 + 严重度

2. 用架构图节点（name + aliases + host/ip/port）做本体候选集注入 prompt，
   强制 LLM「只能从已知实体里选」，让 reddis / 缓存集群 / redis-2 这类变体
   语义收敛到同一图节点 —— 替代 `_resource_match` 子串匹配与 `_endpoint_matches` 全等匹配。

3. 模板缓存降本（LILAC/XLog 思想）：相同 template_id（或归一化模板签名）命中缓存
   直接返回，不调 LLM；只有没见过的新模板才真正调 LLM。

4. 降级回退：开关关闭 / 网关未配置 / 调用失败 / 返回非法时返回 None，
   由调用方回退到现有关键词 `_signals` + 正则。LLM 是「增强」不是「替换」。

本模块只读环境变量（与 lib/logfault 风格一致），不 import app.Settings，
保持与 lib/logfault 相同的独立、可测试边界。
"""

import json
import logging
import os
import re
import threading
import time
from typing import Any

try:
    import requests
except Exception:  # pragma: no cover
    requests = None

try:
    from json_repair import repair_json
except Exception:  # pragma: no cover
    def repair_json(text: str) -> str:
        return text


logger = logging.getLogger(__name__)

# 与 rca_engine._signals 的 fault_mode 枚举保持一致，作为 LLM 输出收敛的受控词表。
# LLM 只能从这些枚举里选，避免自由发挥出下游无法理解的 mode。
_FAULT_MODES = (
    "JVM_OOM",
    "REDIS_UNREACHABLE",
    "REDIS_TIMEOUT",
    "DB_POOL_EXHAUSTED",
    "DB_DEADLOCK",
    "DB_LOCK_TIMEOUT",
    "DATABASE_UNREACHABLE",
    "DATABASE_FAILURE",
    "MESSAGE_BROKER_FAILURE",
    "DISK_IO_FAILURE",
    "CPU_OVERLOAD",
    "NETWORK_FAILURE",
    "AUTH_FAILURE",
    "CIRCUIT_BREAKER_OPEN",
    "DEPENDENCY_FAILURE",
    "APPLICATION_ERROR",
)

# 故障模式 → 匹配该模式所需的资源类型（与 FaultSignal.resource_kinds 语义一致）。
_FAULT_RESOURCE_KINDS: dict[str, tuple[str, ...]] = {
    "JVM_OOM": ("Service", "Pod", "Instance"),
    "REDIS_UNREACHABLE": ("Cache", "Cluster", "Instance", "Host", "Database", "Middleware"),
    "REDIS_TIMEOUT": ("Cache", "Cluster", "Instance", "Host", "Database", "Middleware"),
    "DB_POOL_EXHAUSTED": ("Database", "Service", "Cluster", "Host"),
    "DB_DEADLOCK": ("Database", "Cluster", "Instance", "Host"),
    "DB_LOCK_TIMEOUT": ("Database", "Cluster", "Instance", "Host"),
    "DATABASE_UNREACHABLE": ("Database", "Cluster", "Instance", "Host"),
    "DATABASE_FAILURE": ("Database", "Cluster", "Instance", "Host"),
    "MESSAGE_BROKER_FAILURE": ("Queue", "Cluster", "Instance", "Host", "Middleware"),
    "DISK_IO_FAILURE": ("Host", "Instance", "Pod", "VM"),
    "CPU_OVERLOAD": ("Host", "Instance", "Pod", "VM"),
    "NETWORK_FAILURE": ("Host", "Instance", "VM", "Cluster"),
    "AUTH_FAILURE": ("Service", "API", "Component"),
    "CIRCUIT_BREAKER_OPEN": ("Service", "API", "Component", "Middleware"),
    "DEPENDENCY_FAILURE": ("Database", "Cache", "Queue", "Middleware", "Cluster", "Instance", "Host", "Service"),
    "APPLICATION_ERROR": ("Service", "API", "Component"),
}

# 故障模式 → 是否「仅超时」（超时不能证明节点宕机，用于后续证据分级）。
_TIMEOUT_ONLY_MODES = frozenset(
    {
        "REDIS_TIMEOUT",
        "DB_POOL_EXHAUSTED",
        "DB_LOCK_TIMEOUT",
        "CPU_OVERLOAD",
        "DEPENDENCY_FAILURE",
    }
)

_SYSTEM_PROMPT = (
    "你是生产故障日志结构化抽取助手。请严格返回 JSON 对象，不要 Markdown、不要解释、不要代码块。"
    "只能从给定候选集与枚举中取值，不得编造日志中不存在的信息。"
)

_CACHE_MISS = object()

_cache_lock = threading.Lock()
_cache: dict[str, tuple[float, Any]] = {}


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _cache_max_entries() -> int:
    return max(1, _int_env("LLM_EXTRACT_CACHE_MAX_ENTRIES", 4096))


def _cache_ttl_seconds() -> float:
    raw = os.getenv("LLM_EXTRACT_CACHE_TTL_SECONDS", "3600")
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 3600.0


def _negative_cache_ttl_seconds() -> float:
    raw = os.getenv("LLM_EXTRACT_NEGATIVE_TTL_SECONDS", "60")
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 60.0


def _cache_get(key: str) -> Any:
    with _cache_lock:
        entry = _cache.get(key)
        if entry is None:
            return _CACHE_MISS
        expire_at, value = entry
        if expire_at is not None and time.time() > expire_at:
            _cache.pop(key, None)
            return _CACHE_MISS
        return value


def _cache_put(key: str, value: Any, ttl: float) -> None:
    expire_at = time.time() + ttl if ttl > 0 else None
    with _cache_lock:
        if len(_cache) >= _cache_max_entries() and key not in _cache:
            try:
                _cache.pop(next(iter(_cache)), None)
            except StopIteration:  # pragma: no cover
                pass
        _cache[key] = (expire_at, value)


# ── 日志文本组装 ───────────────────────────────────────────────────

_EVENT_TEXT_KEYS = ("root_cause", "semantic_message", "message", "raw_block", "description")


def _event_text(detail: dict[str, Any]) -> str:
    """从 detail 里拼出一条代表性报错文本，作为 LLM 抽取的输入。

    优先级与 log_compression._event_message 一致：root_cause > semantic_message > message。
    """
    parts: list[str] = []
    for key in ("root_cause_candidate", "root_evidence"):
        value = detail.get(key)
        if value not in (None, ""):
            parts.append(str(value).strip())
    for item in detail.get("root_candidates") or []:
        if not isinstance(item, dict):
            continue
        for key in ("root_exception_class", "root_cause", "message", "logger"):
            value = item.get(key)
            if value not in (None, ""):
                parts.append(str(value).strip())
    for item in detail.get("timeline") or []:
        if isinstance(item, dict) and str(item.get("level") or "").upper() in {"WARN", "ERROR", "FATAL"}:
            for key in ("root_cause", "message", "logger"):
                value = item.get(key)
                if value not in (None, ""):
                    parts.append(str(value).strip())
    return re.sub(r"\s+", " ", " | ".join(parts)).strip()


def _normalize_signature(text: str) -> str:
    """归一化日志文本作为模板缓存键（无 template_id 时的降级）。"""
    norm = re.sub(r"\s+", " ", text).strip().lower()
    norm = re.sub(r"\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b", "<ip>", norm)
    norm = re.sub(r"\b[0-9a-f]{8,}\b", "<hex>", norm)
    norm = re.sub(r"\b\d+\b", "<num>", norm)
    return norm


def _cache_key(detail: dict[str, Any], text: str) -> str | None:
    # 优先用 template_id（若上游解析已产出）；否则用归一化文本签名。
    template_id = str(detail.get("template_id") or "").strip()
    if template_id:
        return f"tid:{template_id}"
    norm = _normalize_signature(text)
    if len(norm) < 3:
        return None
    return f"txt:{norm}"


# ── 架构图节点 → 本体候选集 ─────────────────────────────────────────

def _node_candidates(graph_nodes: Any) -> list[dict[str, str]]:
    """把架构图节点压成 prompt 里的候选实体表（name + 标识符 + kind）。"""
    candidates: list[dict[str, str]] = []
    for node in graph_nodes or []:
        if isinstance(node, dict):
            name = str(node.get("name") or node.get("id") or "")
            kind = str(node.get("kind") or "Component")
            meta = node.get("meta") if isinstance(node.get("meta"), dict) else {}
        else:
            name = str(getattr(node, "name", "") or "")
            kind = str(getattr(node, "kind", "Component") or "Component")
            meta = getattr(node, "meta", None) or {}
        if not name:
            continue
        identifiers: list[str] = []
        for key in ("alias", "aliases", "service", "service_name", "instance", "instance_id",
                    "host", "hostname", "ip", "endpoint", "endpoints"):
            raw = meta.get(key)
            if raw is None:
                continue
            if isinstance(raw, (list, tuple, set)):
                identifiers.extend(str(item) for item in raw if str(item).strip())
            elif isinstance(raw, str) and raw.strip():
                identifiers.extend(item.strip() for item in re.split(r"[,，;；]", raw) if item.strip())
        candidates.append(
            {
                "name": name,
                "kind": kind,
                "identifiers": " ".join(dict.fromkeys(identifiers)),
            }
        )
    return candidates


def _extract_prompt(detail: dict[str, Any], text: str, graph_nodes: Any) -> str:
    candidates = _node_candidates(graph_nodes)
    fault_modes = ", ".join(_FAULT_MODES)
    candidate_lines = "\n".join(
        f'- {{"name": {json.dumps(item["name"], ensure_ascii=False)}, '
        f'"kind": {json.dumps(item["kind"], ensure_ascii=False)}, '
        f'"identifiers": {json.dumps(item["identifiers"], ensure_ascii=False)}}}'
        for item in candidates[:200]
    )
    if not candidate_lines:
        candidate_lines = "(架构图为空，resource.matched_node_id 置空)"
    return (
        "请把下面这条生产报错日志抽成结构化结果。\n\n"
        "要求：\n"
        "1. template：语义模板，变量用命名占位符（如 <host> <port> <service>），保留故障语义；\n"
        "2. parameters：从日志中实际抽取的命名变量值；\n"
        "3. resource：日志涉及的资源实体。type 用 kind 语义（如 redis/database/mq/disk/cpu/network/service），"
        "instance 是日志里出现的实例名/host；matched_node_id 必须从下面「候选实体表」里选 name，"
        "若日志资源对不上任何候选则置空字符串；\n"
        "4. fault.type 必须从以下枚举选一个（只能选一个）：[" + fault_modes + "]；\n"
        "   fault.evidence 是日志里证明该故障的关键短语（原样摘录，尽量短）；\n"
        "   fault.severity 取 error 或 warn。\n\n"
        "候选实体表（name 是唯一可选的 matched_node_id）：\n"
        + candidate_lines
        + "\n\n"
        "输出格式（严格 JSON，无 Markdown 代码块）：\n"
        '{"template": "<语义模板>", "parameters": {"<name>": "<value>"}, '
        '"resource": {"type": "<type>", "instance": "<instance>", "matched_node_id": "<候选 name 或空>"}, '
        '"fault": {"type": "<枚举>", "evidence": "<证据短语>", "severity": "error"}}\n\n'
        f"日志文本：\n{text}"
    )


def _call_llm(prompt: str) -> str:
    if requests is None:
        raise RuntimeError("requests 未安装，无法调用 LLM 网关")
    base_url = os.getenv("LLM_BASE_URL", "").strip().rstrip("/")
    if not base_url:
        raise RuntimeError("LLM_BASE_URL 未配置")
    url = f"{base_url}/chat/completions" if base_url.endswith("/v1") else f"{base_url}/v1/chat/completions"
    model = os.getenv("LLM_MODEL", "").strip() or os.getenv("LLM_EXTRACT_MODEL", "").strip()
    if not model:
        raise RuntimeError("LLM_MODEL 未配置")
    api_key = os.getenv("LLM_API_KEY", "not-needed").strip() or "not-needed"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_tokens": _int_env("LLM_EXTRACT_MAX_TOKENS", 512),
        "stream": False,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    timeout = (
        _int_env("LLM_CONNECT_TIMEOUT_SECONDS", 10),
        _int_env("LLM_EXTRACT_TIMEOUT_SECONDS", 30),
    )
    response = requests.post(url, json=payload, headers=headers, timeout=timeout)
    if response.status_code >= 400:
        raise RuntimeError(f"LLM HTTP {response.status_code}: {response.text[:500]}")
    data = response.json()
    content = data["choices"][0]["message"].get("content") or ""
    if not str(content).strip():
        raise RuntimeError("LLM 返回空内容")
    return str(content)


def _parse_json(content: str) -> dict[str, Any]:
    text = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL | re.IGNORECASE).strip()
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("LLM 输出不是 JSON")
    candidate = text[start : end + 1]
    try:
        data = json.loads(candidate)
    except Exception:
        data = json.loads(repair_json(candidate))
    if not isinstance(data, dict):
        raise ValueError("LLM JSON 必须是对象")
    return data


def _normalize_result(parsed: dict[str, Any]) -> dict[str, Any] | None:
    """校验并收敛 LLM 输出到受控 schema；非法时返回 None 触发回退。"""
    fault = parsed.get("fault") if isinstance(parsed.get("fault"), dict) else {}
    fault_type = str(fault.get("type") or "").strip().upper()
    if fault_type not in _FAULT_MODES:
        return None
    resource = parsed.get("resource") if isinstance(parsed.get("resource"), dict) else {}
    resource_type = str(resource.get("type") or "").strip().lower()
    resource_instance = str(resource.get("instance") or "").strip()
    matched_node_id = str(resource.get("matched_node_id") or "").strip()
    severity = str(fault.get("severity") or "error").strip().lower()
    if severity not in {"error", "warn"}:
        severity = "error"
    return {
        "template": str(parsed.get("template") or "").strip(),
        "parameters": parsed.get("parameters") if isinstance(parsed.get("parameters"), dict) else {},
        "resource": {
            "type": resource_type,
            "instance": resource_instance,
            "matched_node_id": matched_node_id,
        },
        "fault": {
            "type": fault_type,
            "evidence": str(fault.get("evidence") or "").strip(),
            "severity": severity,
        },
    }


def extract_event(
    detail: dict[str, Any],
    graph_nodes: Any,
    text: str | None = None,
) -> dict[str, Any] | None:
    """LLM 结构化抽取单条日志。

    返回受控 schema（见 _normalize_result）；开关未开启、网关未配置、调用失败、
    返回非法时返回 None，由调用方回退现有关键词逻辑。

    带模板缓存（B2）：相同 template_id（或归一化签名）命中缓存直接返回，不调 LLM。
    """
    if not _bool_env("LLM_EXTRACT_ENABLED", False):
        return None
    if text is None:
        text = _event_text(detail)
    if not text.strip():
        return None

    cache_key = _cache_key(detail, text)
    if cache_key is not None:
        cached = _cache_get(cache_key)
        if cached is not _CACHE_MISS:
            return cached

    try:
        content = _call_llm(_extract_prompt(detail, text, graph_nodes))
        parsed = _parse_json(content)
        result = _normalize_result(parsed)
    except Exception as exc:  # noqa: BLE001
        logger.info("[LLM-EXTRACT] 抽取失败，回退关键词: %s", exc)
        if cache_key is not None:
            _cache_put(cache_key, None, _negative_cache_ttl_seconds())
        return None

    if result is None:
        if cache_key is not None:
            _cache_put(cache_key, None, _negative_cache_ttl_seconds())
        return None

    if cache_key is not None:
        _cache_put(cache_key, result, _cache_ttl_seconds())
    return result


def fault_resource_kinds(fault_mode: str) -> tuple[str, ...]:
    return _FAULT_RESOURCE_KINDS.get(fault_mode, ())


def fault_timeout_only(fault_mode: str) -> bool:
    return fault_mode in _TIMEOUT_ONLY_MODES


def reset_cache() -> None:
    """清空模板缓存（测试/调试用）。"""
    with _cache_lock:
        _cache.clear()
