from __future__ import annotations

import re
from typing import Any


MAX_INCIDENT_TITLE_LENGTH = 60


def normalize_incident_title(value: Any) -> str:
    """Validate a short Chinese model summary, without translating exceptions by rules."""
    if not isinstance(value, str):
        return ""
    title = re.sub(r"\s+", " ", value).strip().strip('`"\'“”').strip()
    # A raw exception class or an object serialized as text is not a user summary.
    if not re.search(r"[\u4e00-\u9fff]", title) or title.startswith(("{", "[")):
        return ""
    if len(title) > MAX_INCIDENT_TITLE_LENGTH:
        title = title[: MAX_INCIDENT_TITLE_LENGTH - 1].rstrip(" ，,；;。") + "…"
    return title


def build_incident_title(detail: dict[str, Any], decision: dict[str, Any]) -> str:
    """Use the model's summary verbatim; missing summaries must not invent a diagnosis."""
    if str(decision.get("source") or "").lower() == "llm":
        title = normalize_incident_title(decision.get("incident_title"))
        if title:
            return title
    service = re.sub(r"\s+", " ", str(detail.get("root_service_candidate") or "")).strip()
    suffix = "发生异常，根因待确认"
    if not service:
        return "检测到日志异常，根因待确认"
    available = MAX_INCIDENT_TITLE_LENGTH - len(suffix)
    if len(service) > available:
        service = service[: available - 1] + "…"
    return f"{service}{suffix}"
