from __future__ import annotations

import json
import re
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

from .config import get_settings


class _UnavailableSession:
    trust_env = False

    def post(self, *args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("requests package is unavailable")


class RcaDecisionService:
    """Ask the preferred RCA decision model to choose the strongest hypothesis."""

    def __init__(self, settings: Any | None = None, session: Any | None = None) -> None:
        self.settings = settings or get_settings()
        self.session = session or (requests.Session() if requests is not None else _UnavailableSession())
        if bool(getattr(self.settings, "llm_disable_env_proxy", True)):
            self.session.trust_env = False

    def enrich(self, detail: dict[str, Any], analysis: dict[str, Any]) -> dict[str, Any]:
        fallback = self._fallback_decision(analysis, source="fallback")
        if not bool(getattr(self.settings, "rca_decision_enabled", True)):
            return {**fallback, "error": "RCA decision model is disabled"}

        try:
            raw_content, meta = self._post_conversation(self._build_prompt(detail, analysis))
            parsed = self._parse_model_json(raw_content)
            result = self._normalize_model_result(parsed, analysis, fallback)
            return {
                **result,
                "source": "llm",
                "model_config_id": str(getattr(self.settings, "rca_decision_model_config_id", "") or ""),
                "conversation_id": str(meta.get("conversation_id") or ""),
                "raw_content": raw_content,
            }
        except Exception as exc:  # noqa: BLE001
            return {
                **fallback,
                "error": str(exc),
            }

    def _post_conversation(self, prompt: str) -> tuple[str, dict[str, Any]]:
        payload = {
            "content": prompt,
            "conversation_id": str(getattr(self.settings, "rca_decision_conversation_id", "") or ""),
            "model_config_id": str(getattr(self.settings, "rca_decision_model_config_id", "") or ""),
            "attachments": [],
            "stream": bool(getattr(self.settings, "rca_decision_stream", False)),
            "code_language": str(getattr(self.settings, "rca_decision_code_language", "") or ""),
            "assistant_role": str(getattr(self.settings, "rca_decision_assistant_role", "general") or "general"),
            "assistant_name": str(
                getattr(self.settings, "rca_decision_assistant_name", "normal_assistant")
                or "normal_assistant"
            ),
            "assistant_prompt": str(getattr(self.settings, "rca_decision_assistant_prompt", "") or ""),
            "kb_id": self._nullable_setting("rca_decision_kb_id"),
            "kb_name": self._nullable_setting("rca_decision_kb_name"),
        }
        response = self.session.post(
            str(getattr(self.settings, "rca_decision_url", "http://127.0.0.1/api/conversation")),
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=(
                int(getattr(self.settings, "rca_decision_connect_timeout_seconds", 10)),
                int(getattr(self.settings, "rca_decision_timeout_seconds", 90)),
            ),
        )
        if response.status_code >= 400:
            raise RuntimeError(f"decision model HTTP {response.status_code}: {response.text[:1200]}")
        content, meta = self._conversation_content(response)
        if not content.strip():
            raise RuntimeError("decision model returned empty content")
        return content, meta

    def _nullable_setting(self, name: str) -> str | None:
        value = getattr(self.settings, name, None)
        text = str(value or "").strip()
        return text or None

    def _conversation_content(self, response: Any) -> tuple[str, dict[str, Any]]:
        text = str(getattr(response, "text", "") or "")
        if "data:" not in text:
            try:
                data = response.json()
                return self._content_from_json(data), self._meta_from_json(data)
            except Exception:
                if text.strip():
                    return text.strip(), {}
                raise

        chat_content = ""
        assistant_parts: list[str] = []
        meta: dict[str, Any] = {}
        for raw_line in response.iter_lines(decode_unicode=True):
            line = raw_line.decode("utf-8", errors="replace") if isinstance(raw_line, bytes) else str(raw_line)
            line = line.strip()
            if not line or not line.startswith("data:"):
                continue
            data_text = line[5:].strip()
            if data_text == "[DONE]":
                break
            try:
                event = json.loads(data_text)
            except json.JSONDecodeError:
                continue
            meta.update(self._meta_from_json(event))
            content = self._content_to_text(event.get("content"))
            message_type = str(event.get("message_type") or "")
            if content and message_type == "chat":
                chat_content = content
            elif content and message_type in {"assistant_delta", "assistant"}:
                assistant_parts.append(content)
            elif content and not message_type:
                assistant_parts.append(content)
        return (chat_content or "".join(assistant_parts)).strip(), meta

    def _content_from_json(self, data: Any) -> str:
        if isinstance(data, dict):
            for key in ("content", "response", "text", "message"):
                if key in data:
                    return self._content_to_text(data[key])
            if data.get("data"):
                return self._content_from_json(data["data"])
        return self._content_to_text(data)

    def _meta_from_json(self, data: Any) -> dict[str, Any]:
        if not isinstance(data, dict):
            return {}
        return {
            key: data[key]
            for key in ("conversation_id", "execute_id", "id", "message_type")
            if data.get(key) is not None
        }

    def _content_to_text(self, value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            return "\n".join(self._content_to_text(item) for item in value if item is not None)
        if isinstance(value, dict):
            for key in ("content", "response", "text", "message", "value"):
                if key in value:
                    return self._content_to_text(value[key])
            return json.dumps(value, ensure_ascii=False)
        return str(value)

    def _parse_model_json(self, content: str) -> dict[str, Any]:
        text = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL | re.IGNORECASE).strip()
        text = re.sub(r"^```(?:json)?", "", text).strip()
        text = re.sub(r"```$", "", text).strip()
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end < start:
            raise ValueError("decision model output is not JSON")
        candidate = text[start : end + 1]
        try:
            data = json.loads(candidate)
        except Exception:
            data = json.loads(repair_json(candidate))
        if not isinstance(data, dict):
            raise ValueError("decision model JSON must be an object")
        return data

    def _normalize_model_result(
        self,
        parsed: dict[str, Any],
        analysis: dict[str, Any],
        fallback: dict[str, Any],
    ) -> dict[str, Any]:
        hypotheses = analysis.get("hypotheses") if isinstance(analysis.get("hypotheses"), list) else []
        selected = str(parsed.get("selected_candidate") or parsed.get("candidate") or "").strip()
        rank = self._safe_int(parsed.get("selected_candidate_rank") or parsed.get("selected_rank"))
        if not selected and rank:
            selected = self._candidate_by_rank(hypotheses, rank)
        if selected and not rank:
            rank = self._rank_by_candidate(hypotheses, selected)
        if not selected:
            selected = fallback["selected_candidate"]
        if not rank:
            rank = int(fallback.get("selected_candidate_rank") or 0)

        steps = self._normalize_steps(
            parsed.get("troubleshooting_methods")
            or parsed.get("troubleshooting_steps")
            or parsed.get("check_methods")
        )
        if not steps:
            steps = list(fallback["troubleshooting_methods"])

        reason = str(
            parsed.get("most_likely_reason")
            or parsed.get("reason")
            or parsed.get("summary")
            or fallback["most_likely_reason"]
        ).strip()
        fault_mode = str(
            parsed.get("selected_fault_mode")
            or self._fault_mode_by_rank(hypotheses, rank)
            or fallback.get("selected_fault_mode")
            or ""
        ).strip()
        return {
            "selected_candidate": selected,
            "selected_candidate_rank": rank,
            "selected_fault_mode": fault_mode,
            "most_likely_reason": reason,
            "troubleshooting_methods": steps,
            "confidence": parsed.get("confidence", fallback.get("confidence")),
            "notes": self._normalize_steps(parsed.get("notes")),
        }

    def _fallback_decision(self, analysis: dict[str, Any], source: str) -> dict[str, Any]:
        hypotheses = analysis.get("hypotheses") if isinstance(analysis.get("hypotheses"), list) else []
        top = hypotheses[0] if hypotheses and isinstance(hypotheses[0], dict) else {}
        steps = self._steps_from_validation(top.get("validation_suggestions") or [])
        if not steps:
            steps = self._normalize_steps(top.get("missing_evidence") or [])
        if not steps:
            steps = ["补充日志、监控和组件健康状态，核对候选根因与故障时间窗口是否一致。"]
        return {
            "selected_candidate": str(top.get("candidate") or ""),
            "selected_candidate_rank": self._safe_int(top.get("rank")) or 0,
            "selected_fault_mode": str(top.get("fault_mode") or ""),
            "most_likely_reason": str(top.get("summary") or analysis.get("decision") or ""),
            "troubleshooting_methods": steps,
            "confidence": top.get("confidence"),
            "source": source,
            "model_config_id": str(getattr(self.settings, "rca_decision_model_config_id", "") or ""),
            "conversation_id": "",
            "raw_content": "",
        }

    def _steps_from_validation(self, items: list[Any]) -> list[str]:
        steps: list[str] = []
        for item in items:
            if isinstance(item, dict):
                title = str(item.get("title") or item.get("check_id") or "").strip()
                reason = str(item.get("reason") or "").strip()
                hint = str(item.get("manual_command_hint") or "").strip()
                text = "；".join(part for part in [title, reason, hint] if part)
                if text:
                    steps.append(text)
            elif str(item).strip():
                steps.append(str(item).strip())
        return steps[:8]

    def _normalize_steps(self, value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            try:
                decoded = json.loads(value)
                if isinstance(decoded, list):
                    return self._normalize_steps(decoded)
            except Exception:
                pass
            return [item.strip() for item in re.split(r"\n+|[；;]", value) if item.strip()][:8]
        if isinstance(value, dict):
            value = [value]
        if isinstance(value, list):
            steps: list[str] = []
            for item in value:
                if isinstance(item, dict):
                    text = "；".join(
                        str(item.get(key) or "").strip()
                        for key in ("step", "title", "method", "description", "reason", "command")
                        if str(item.get(key) or "").strip()
                    )
                else:
                    text = str(item or "").strip()
                if text:
                    steps.append(text)
            return steps[:8]
        return [str(value).strip()] if str(value).strip() else []

    def _build_prompt(self, detail: dict[str, Any], analysis: dict[str, Any]) -> str:
        prompt_data = {
            "incident": {
                "incident_id": detail.get("incident_id") or analysis.get("incident_id"),
                "root_service_candidate": detail.get("root_service_candidate"),
                "root_cause_candidate": detail.get("root_cause_candidate"),
                "root_evidence": detail.get("root_evidence"),
                "fault_start": detail.get("fault_start"),
                "fault_end": detail.get("fault_end"),
                "timeline": (detail.get("timeline") or [])[:20] if isinstance(detail.get("timeline"), list) else [],
            },
            "deterministic_rca": {
                "decision": analysis.get("decision"),
                "resolved_root_service": analysis.get("resolved_root_service"),
                "hypotheses": (analysis.get("hypotheses") or [])[:8],
                "limitations": analysis.get("limitations") or [],
            },
        }
        return (
            "你是生产故障 RCA 决策助手。请只基于输入的候选根因、证据和限制信息，"
            "选出一个最可能原因，并给出可执行的排查方法。不要编造候选根因或不存在的证据。\n"
            "请严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。JSON 格式：\n"
            "{"
            "\"selected_candidate\":\"候选名称\","
            "\"selected_candidate_rank\":1,"
            "\"selected_fault_mode\":\"故障模式\","
            "\"most_likely_reason\":\"为什么它最可能\","
            "\"troubleshooting_methods\":[\"排查步骤1\",\"排查步骤2\"],"
            "\"confidence\":0.0,"
            "\"notes\":[\"需要补充的证据或注意点\"]"
            "}\n"
            f"输入数据：\n{json.dumps(prompt_data, ensure_ascii=False, indent=2)}"
        )

    def _safe_int(self, value: Any) -> int:
        try:
            return int(value)
        except Exception:
            return 0

    def _candidate_by_rank(self, hypotheses: list[Any], rank: int) -> str:
        for item in hypotheses:
            if isinstance(item, dict) and self._safe_int(item.get("rank")) == rank:
                return str(item.get("candidate") or "")
        return ""

    def _rank_by_candidate(self, hypotheses: list[Any], candidate: str) -> int:
        for item in hypotheses:
            if isinstance(item, dict) and str(item.get("candidate") or "") == candidate:
                return self._safe_int(item.get("rank"))
        return 0

    def _fault_mode_by_rank(self, hypotheses: list[Any], rank: int) -> str:
        for item in hypotheses:
            if isinstance(item, dict) and self._safe_int(item.get("rank")) == rank:
                return str(item.get("fault_mode") or "")
        return ""
