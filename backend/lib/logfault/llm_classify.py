from __future__ import annotations

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

# ── 模板缓存（P1 降本）────────────────────────────────────────────
# 同一模板的日志，故障分类结果天然相同（LLM 看的是「日志语义」，同模板 = 同语义）。
# 生产环境同类错误一天重复成千上万次，只有第一次真正调 LLM，之后命中缓存直接返回。
# 学 LILAC/XLog 的模板缓存思想：先缓存、命中就不调 LLM，只把「没见过的新模板」交给 LLM。

# 命中缓存的分类结果：值为 dict（成功结果）或 None（负缓存：LLM 失败，短 TTL 内不再重试）。
# 用 _CACHE_MISS 哨兵区分「缓存未命中」与「缓存值为 None（负缓存）」。
_CACHE_MISS = object()

_cache_lock = threading.Lock()
_cache: dict[str, tuple[float, Any]] = {}  # key -> (expire_at, result_or_None)


def _cache_max_entries() -> int:
    raw = os.getenv("LLM_CLASSIFY_CACHE_MAX_ENTRIES", "4096")
    try:
        return max(1, int(raw))
    except ValueError:
        return 4096


def _cache_ttl_seconds() -> float:
    # 成功结果缓存 TTL：默认 1 小时，稳态后趋近零 LLM 调用。
    raw = os.getenv("LLM_CLASSIFY_CACHE_TTL_SECONDS", "3600")
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 3600.0


def _negative_cache_ttl_seconds() -> float:
    # 负缓存 TTL：LLM 失败时短缓存，避免不可用期间雪崩式重试。默认 60 秒。
    raw = os.getenv("LLM_CLASSIFY_NEGATIVE_TTL_SECONDS", "60")
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 60.0


def _cache_key(row: dict[str, Any], text: str) -> str | None:
    """构造缓存键：优先 template_id，缺失时降级为归一化 message 文本。

    返回 None 表示无法构造稳定键（不缓存）。
    """
    template_id = str(row.get("template_id") or "").strip()
    if template_id:
        return f"tid:{template_id}"
    # 归一化：折叠空白、统一小写，去除纯数字/IP 等易变片段，尽量让同类日志收敛到同一键。
    norm = re.sub(r"\s+", " ", text).strip().lower()
    norm = re.sub(r"\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b", "<ip>", norm)
    norm = re.sub(r"\b[0-9a-f]{8,}\b", "<hex>", norm)
    norm = re.sub(r"\b\d+\b", "<num>", norm)
    if len(norm) < 3:
        return None
    return f"txt:{norm}"


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
            # 简单淘汰：丢弃最早插入的一项，避免缓存无限增长。
            try:
                oldest = next(iter(_cache))
                _cache.pop(oldest, None)
            except StopIteration:  # pragma: no cover
                pass
        _cache[key] = (expire_at, value)


def _cache_stats() -> dict[str, int]:
    with _cache_lock:
        return {"size": len(_cache)}


# 与 explain.py 的 TECHNICAL_FAULT_FAMILIES 保持一致，另加业务/鉴权/未知三类。
_FAULT_FAMILIES = (
    "memory", "disk", "hardware", "mq", "redis", "database",
    "classloading", "network", "timeout", "authentication", "business", "unknown",
)

_SYSTEM_PROMPT = (
    "你是生产日志故障分类助手。请严格返回 JSON 对象，不要 Markdown、不要解释、不要代码块。"
    "只做分类判断，不要编造日志中不存在的信息。"
)

_EVENT_TEXT_KEYS = ("message", "semantic_message", "root_cause", "raw_block", "description")


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _event_text(row: dict[str, Any]) -> str:
    parts = []
    for key in _EVENT_TEXT_KEYS:
        value = row.get(key)
        if value not in (None, ""):
            parts.append(str(value).strip())
    class_name = str(row.get("root_exception_class") or row.get("exception_class") or "").strip()
    if class_name:
        parts.append(class_name)
    return " | ".join(parts)


def _classify_prompt(row: dict[str, Any], text: str) -> str:
    families = ", ".join(_FAULT_FAMILIES)
    return (
        f"请判断下面这条日志的故障类型，并从以下枚举中选择 fault_family（只能选一个）：\n"
        f"[{families}]\n\n"
        f"同时判断 is_technical：如果是系统/基础设施/依赖故障（redis、数据库、网络、超时、内存、"
        f"磁盘、硬件、消息队列、类加载等）返回 true；如果是业务逻辑错误（参数非法、状态非法、"
        f"业务规则不满足等）返回 false。\n\n"
        f"输出格式（严格 JSON）：\n"
        f'{{"fault_family": "<枚举值>", "is_technical": <true|false>, "explanation": "<一句话解释>"}}\n\n'
        f"日志文本：\n{text}"
    )


def _call_llm(prompt: str) -> str:
    if requests is None:
        raise RuntimeError("requests 未安装，无法调用 LLM 网关")
    base_url = os.getenv("LLM_BASE_URL", "").strip().rstrip("/")
    if not base_url:
        raise RuntimeError("LLM_BASE_URL 未配置")
    if base_url.endswith("/v1"):
        url = f"{base_url}/chat/completions"
    else:
        url = f"{base_url}/v1/chat/completions"
    model = os.getenv("LLM_MODEL", "").strip() or os.getenv("LLM_CLASSIFY_MODEL", "").strip()
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
        "max_tokens": int(os.getenv("LLM_CLASSIFY_MAX_TOKENS", "256")),
        "stream": False,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    timeout = (
        int(os.getenv("LLM_CONNECT_TIMEOUT_SECONDS", "10")),
        int(os.getenv("LLM_CLASSIFY_TIMEOUT_SECONDS", "30")),
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


def classify_event(row: dict[str, Any], text: str | None = None) -> dict[str, Any] | None:
    """用 LLM 分类单条日志的故障族与技术性。

    返回 {"fault_family": str, "is_technical": bool, "explanation": str}；
    开关未开启、网关未配置、调用失败或返回非法时返回 None，由调用方回退关键词逻辑。

    带模板缓存（P1）：相同 template_id（或归一化 message）命中缓存直接返回，不调 LLM；
    LLM 失败时写负缓存，短 TTL 内不再重复调用。
    """
    if not _bool_env("LLM_CLASSIFY_ENABLED", False):
        return None
    if text is None:
        text = _event_text(row)
    if not text.strip():
        return None

    cache_key = _cache_key(row, text)
    if cache_key is not None:
        cached = _cache_get(cache_key)
        if cached is not _CACHE_MISS:
            # 命中（含负缓存命中，值为 None）：直接返回，不调 LLM。
            return cached

    try:
        content = _call_llm(_classify_prompt(row, text))
        parsed = _parse_json(content)
    except Exception as exc:  # noqa: BLE001
        logger.info("[LLM-CLASSIFY] 分类失败，回退关键词: %s", exc)
        if cache_key is not None:
            _cache_put(cache_key, None, _negative_cache_ttl_seconds())
        return None

    family = str(parsed.get("fault_family") or "unknown").strip().lower()
    if family not in _FAULT_FAMILIES:
        family = "unknown"
    is_technical = bool(parsed.get("is_technical", False))
    explanation = str(parsed.get("explanation") or "").strip()
    result = {
        "fault_family": family,
        "is_technical": is_technical,
        "explanation": explanation,
    }
    if cache_key is not None:
        _cache_put(cache_key, result, _cache_ttl_seconds())
    return result
