from __future__ import annotations

import hashlib
import ipaddress
import json
import re
from typing import Any
from urllib.parse import urlsplit, urlunsplit

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
from .log_compression import LogCompressionConfig, LogContextCompressor


_KIND_CODES = {
    "Service": "SV",
    "API": "API",
    "Component": "CP",
    "Database": "DB",
    "Cache": "CA",
    "Middleware": "MW",
    "Queue": "MQ",
    "Cluster": "CL",
    "Instance": "IN",
    "Host": "HO",
    "VM": "VM",
    "Pod": "PD",
    "NetworkSwitch": "NW",
    "UIControl": "UI",
    "UIFunction": "UF",
    "Function": "FN",
    "System": "SYS",
}

_RELATION_CODES = {
    "CALLS": "C",
    "DEPENDS_ON": "D",
    "USES_DB": "U",
    "READS": "R",
    "WRITES": "W",
    "PUBLISHES": "P",
    "SUBSCRIBES": "S",
    "CONNECTS_TO": "X",
    "RUNS_ON": "O",
    "HOSTED_ON": "H",
    "HAS_MEMBER": "M",
    "CONTAINS": "N",
    "BELONGS_TO": "B",
    "MEMBER_OF": "MO",
    "ROUTES_TO": "T",
    "TRIGGERS": "G",
}

# Only operational identifiers that help bind logs to architecture entities are
# allowed into the model prompt.  Keeping this list explicit avoids leaking
# credentials or arbitrary document metadata stored in HugeGraph.
_RUNTIME_META_FIELDS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("aliases", "a", ("aliases", "alias", "raw_service")),
    ("hostnames", "h", ("host", "hosts", "hostname", "hostnames")),
    ("ips", "ip", ("ip", "ips", "ip_address", "ip_addresses")),
    ("ports", "p", ("port", "ports", "service_port", "target_port", "container_port")),
    ("endpoints", "ep", ("endpoint", "endpoints", "address", "addresses")),
    ("instance_ids", "ins", ("instance", "instance_id", "instanceId", "instance_ids")),
    ("service_names", "svc", ("service", "service_name", "serviceName", "application_name")),
    ("clusters", "cl", ("cluster", "cluster_name", "clusterName")),
    ("namespaces", "ns", ("namespace", "namespaces")),
    ("pods", "pod", ("pod", "pod_name", "podName", "pods")),
    ("protocols", "pr", ("protocol", "protocols", "scheme")),
    ("regions", "rg", ("region", "regions")),
    ("zones", "z", ("zone", "availability_zone", "zones")),
    ("health_checks", "hc", ("health_check", "health_check_url", "health_url", "probe")),
)

_RUNTIME_PROMPT_KEYS = {full: short for full, short, _ in _RUNTIME_META_FIELDS}
_TARGET_FIELD_ALIASES = {
    "a": "aliases",
    "alias": "aliases",
    "aliases": "aliases",
    "h": "hostnames",
    "host": "hostnames",
    "hostname": "hostnames",
    "hostnames": "hostnames",
    "ip": "ips",
    "ips": "ips",
    "p": "ports",
    "port": "ports",
    "ports": "ports",
    "ep": "endpoints",
    "endpoint": "endpoints",
    "endpoints": "endpoints",
    "ins": "instance_ids",
    "instance": "instance_ids",
    "instance_id": "instance_ids",
    "svc": "service_names",
    "service": "service_names",
    "service_name": "service_names",
    "cl": "clusters",
    "cluster": "clusters",
    "ns": "namespaces",
    "namespace": "namespaces",
    "pod": "pods",
    "pr": "protocols",
    "protocol": "protocols",
    "hc": "health_checks",
    "health_check": "health_checks",
}

_IPV4_RE = re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")
_ENDPOINT_RE = re.compile(
    r"(?i)(?:https?|redis|rediss|mysql|postgres(?:ql)?|amqp|kafka)://[^\s,;]+|"
    r"(?<![\w.-])(?:[a-z0-9][a-z0-9.-]*|(?:\d{1,3}\.){3}\d{1,3}):\d{2,5}(?!\d)"
)


class _UnavailableSession:
    trust_env = False

    def post(self, *args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("requests package is unavailable")


class RcaDecisionService:
    """Ask the preferred RCA decision model to choose the strongest hypothesis."""

    def __init__(
        self,
        settings: Any | None = None,
        session: Any | None = None,
        employee_id: str = "",
        continue_conversation: bool = True,
    ) -> None:
        self.settings = settings or get_settings()
        self.employee_id = employee_id.strip()
        self.continue_conversation = continue_conversation
        self.conversation_id = ""
        self.session = session or (requests.Session() if requests is not None else _UnavailableSession())
        if bool(getattr(self.settings, "llm_disable_env_proxy", True)):
            self.session.trust_env = False
        self.log_compressor = LogContextCompressor(
            LogCompressionConfig(
                enabled=bool(getattr(self.settings, "log_compression_enabled", True)),
                max_chars=int(getattr(self.settings, "log_compression_max_chars", 12_000)),
                max_events=int(getattr(self.settings, "log_compression_max_events", 48)),
                context_radius=int(getattr(self.settings, "log_compression_context_radius", 2)),
                max_patterns=int(getattr(self.settings, "log_compression_max_patterns", 12)),
                max_message_chars=int(getattr(self.settings, "log_compression_max_message_chars", 700)),
            )
        )

    def enrich(
        self,
        detail: dict[str, Any],
        analysis: dict[str, Any],
        architecture: Any | None = None,
    ) -> dict[str, Any]:
        fallback = self._ground_fallback_in_architecture(
            self._fallback_decision(analysis, source="fallback"),
            architecture,
            detail,
        )
        if not bool(getattr(self.settings, "rca_decision_enabled", True)):
            return {**fallback, "error": "RCA decision model is disabled"}

        compression_summary: dict[str, Any] = {}
        try:
            prompt, compression_summary = self._build_prompt_with_meta(detail, analysis, architecture)
            raw_content, meta = self._post_conversation(prompt)
            parsed = self._parse_model_json(raw_content)
            result = self._normalize_model_result(parsed, analysis, fallback, architecture, detail)
            return {
                **result,
                "source": "llm",
                "model_config_id": str(getattr(self.settings, "rca_decision_model_config_id", "") or ""),
                "conversation_id": str(meta.get("conversation_id") or ""),
                "raw_content": raw_content,
                "log_compression": compression_summary,
            }
        except Exception as exc:  # noqa: BLE001
            return {
                **fallback,
                "error": str(exc),
                "log_compression": compression_summary,
            }

    def _post_conversation(self, prompt: str) -> tuple[str, dict[str, Any]]:
        payload = {
            "content": prompt,
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
        if self.continue_conversation and self.conversation_id:
            payload["conversation_id"] = self.conversation_id
        response = self.session.post(
            str(getattr(self.settings, "rca_decision_url", "http://127.0.0.1/api/conversation")),
            json=payload,
            headers={
                "Content-Type": "application/json",
                "X-Ai-Coding-Key": self.employee_id,
            },
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
        returned_conversation_id = str(meta.get("conversation_id") or "").strip()
        if self.continue_conversation and returned_conversation_id:
            self.conversation_id = returned_conversation_id
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
        meta = {
            key: data[key]
            for key in ("conversation_id", "execute_id", "id", "message_type")
            if data.get(key) is not None
        }
        nested = data.get("data")
        if isinstance(nested, dict):
            meta = {**self._meta_from_json(nested), **meta}
        return meta

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
        architecture: Any | None = None,
        detail: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        hypotheses = analysis.get("hypotheses") if isinstance(analysis.get("hypotheses"), list) else []
        catalog = self._architecture_catalog(architecture)
        selected_node_id = self._resolve_catalog_node_id(
            parsed.get("selected_node_id") or parsed.get("root_cause_node_id"),
            catalog,
        )
        if not selected_node_id:
            selected_node_id = self._resolve_catalog_node_id(
                parsed.get("selected_candidate") or parsed.get("candidate"),
                catalog,
            )
        selected_node_id, rejected_instance_id, scope_warning = self._enforce_cluster_scope(
            selected_node_id,
            catalog,
            analysis,
            detail or {},
        )
        promoted_from_node_id = ""
        selected_before_promotion = catalog["by_id"].get(selected_node_id, {})
        if str(selected_before_promotion.get("kind") or "") not in {"Instance", "Host", "VM", "Pod"}:
            aggregate_members = self._possible_member_nodes(selected_node_id, catalog, detail or {})
            if len(aggregate_members) == 1:
                promoted_from_node_id = selected_node_id
                selected_node_id = str(aggregate_members[0].get("node_id") or selected_node_id)
                if rejected_instance_id == selected_node_id:
                    rejected_instance_id = ""
                    scope_warning = ""
        proposed_path = parsed.get("propagation_path") or parsed.get("display_chain")
        if rejected_instance_id and isinstance(proposed_path, list):
            proposed_path = [
                item
                for item in proposed_path
                if self._resolve_catalog_node_id(
                    (item.get("node_id") or item.get("node") or item.get("name"))
                    if isinstance(item, dict)
                    else item,
                    catalog,
                )
                != rejected_instance_id
            ]
        path, path_warnings = self._normalize_architecture_path(
            proposed_path,
            selected_node_id,
            catalog,
        )
        if scope_warning:
            path_warnings.insert(0, scope_warning)
        if promoted_from_node_id:
            aggregate_name = str(
                catalog["by_id"].get(promoted_from_node_id, {}).get("name")
                or promoted_from_node_id
            )
            member_name = str(
                catalog["by_id"].get(selected_node_id, {}).get("name")
                or selected_node_id
            )
            path_warnings.insert(
                0,
                f"聚合节点“{aggregate_name}”仅包含一个真实实例，正式根因已下沉到“{member_name}”。",
            )
        if path:
            selected_node_id = path[0]["node_id"]
        selected_node = catalog["by_id"].get(selected_node_id, {})
        selected = str(
            selected_node.get("name")
            or parsed.get("selected_candidate")
            or parsed.get("candidate")
            or ""
        ).strip()
        rank = self._safe_int(parsed.get("selected_candidate_rank") or parsed.get("selected_rank"))
        if not selected and rank:
            selected = self._candidate_by_rank(hypotheses, rank)
        if selected and not rank:
            rank = self._rank_by_candidate(hypotheses, selected)
        selected_hypothesis = self._selected_hypothesis(hypotheses, selected, rank)
        if selected_hypothesis is None and not selected_node_id:
            selected_hypothesis = self._selected_hypothesis(
                hypotheses,
                str(fallback.get("selected_candidate") or ""),
                int(fallback.get("selected_candidate_rank") or 0),
            )
        if selected_hypothesis is not None and not selected_node_id:
            selected = str(selected_hypothesis.get("candidate") or selected)
            rank = self._safe_int(selected_hypothesis.get("rank")) or rank
        if not selected:
            selected = fallback["selected_candidate"]
        if not rank and not selected_node_id:
            rank = int(fallback.get("selected_candidate_rank") or 0)

        checks, check_warnings = self._normalize_troubleshooting_checks(
            parsed.get("checks")
            or parsed.get("troubleshooting_checks")
            or parsed.get("troubleshooting_methods"),
            catalog,
            selected_node_id,
        )
        steps = [str(item.get("display") or "") for item in checks if item.get("display")]
        if not steps:
            steps = self._normalize_steps(
                parsed.get("troubleshooting_methods")
                or parsed.get("troubleshooting_steps")
                or parsed.get("check_methods")
            )
        if not steps:
            steps = (
                [f"检查架构节点“{selected}”的健康状态、依赖连通性及故障时段日志。"]
                if selected_node_id and selected
                else list(fallback["troubleshooting_methods"])
            )

        reason = str(
            parsed.get("most_likely_reason")
            or parsed.get("reason")
            or parsed.get("summary")
            or (f"日志证据与架构传播路径共同指向“{selected}”。" if selected_node_id and selected else fallback["most_likely_reason"])
        ).strip()
        reason_items = self._normalize_reason_items(
            parsed.get("most_likely_reasons")
            or parsed.get("reason_points")
            or reason
        )
        if not reason_items:
            reason_items = list(fallback.get("most_likely_reasons") or [])
        if not reason_items and reason:
            reason_items = [reason]
        if rejected_instance_id:
            rejected_name = str(catalog["by_id"].get(rejected_instance_id, {}).get("name") or rejected_instance_id)
            reason_items = [
                f"现有日志证据只能定位到集群“{selected}”，不足以确认具体故障实例。",
                f"实例“{rejected_name}”缺少 IP、主机名、Pod 或实例日志等直接证据，"
                "已降为待排查成员而非确认根因。",
            ]
        if promoted_from_node_id:
            aggregate_name = str(
                catalog["by_id"].get(promoted_from_node_id, {}).get("name")
                or promoted_from_node_id
            )
            reason_items.insert(
                0,
                f"“{aggregate_name}”是逻辑聚合节点且只关联一个真实实例，"
                f"实际排查目标已收敛到“{selected}”。",
            )
            reason_items = reason_items[:8]
        root_target = self._node_target_summary(selected_node)
        if selected_node_id and selected and root_target:
            target_reason = f"根因节点：{selected}（{root_target}）"
            if not any(root_target in item for item in reason_items):
                reason_items.insert(0, target_reason)
                reason_items = reason_items[:8]
        fault_mode = str(
            parsed.get("selected_fault_mode")
            or (self._fault_mode_by_rank(hypotheses, rank) if not selected_node_id else "")
            or (fallback.get("selected_fault_mode") if not selected_node_id else "")
            or ""
        ).strip()
        display_chain = (
            path
            if path
            else self._normalize_display_chain(parsed.get("display_chain"), selected_hypothesis)
        )
        possible_members = self._possible_member_nodes(selected_node_id, catalog, detail or {})
        selected_kind = str(selected_node.get("kind") or "")
        member_resolution_warning = ""
        if possible_members:
            root_scope = "cluster"
            instance_resolution = "unresolved_members_listed"
            member_step = (
                "当前证据只能定位到集群，无法确认具体故障实例；请按待排查成员清单逐一检查"
                "节点健康、集群角色、网络连通性和实例日志。"
            )
            if member_step not in steps:
                steps.append(member_step)
        elif selected_kind in {"Instance", "Host", "VM", "Pod"}:
            root_scope = "instance"
            instance_resolution = "resolved_instance"
            if promoted_from_node_id:
                target = self._node_target_summary(selected_node)
                promoted_step = f"直接检查唯一真实实例“{selected}”"
                if target:
                    promoted_step += f"（{target}）"
                promoted_step += "的健康状态、限流指标、网络连通性和实例日志。"
                steps.insert(0, promoted_step)
        elif self._looks_like_aggregate(selected_node):
            root_scope = "cluster"
            instance_resolution = "members_missing"
            member_resolution_warning = (
                f"架构图谱中未找到聚合节点“{selected}”的实例成员关系，"
                "无法生成待排查实例；请补充 HAS_MEMBER、CONTAINS、BELONGS_TO 或 MEMBER_OF 关系。"
            )
            path_warnings.append(member_resolution_warning)
            steps.append(member_resolution_warning)
        else:
            root_scope = "component"
            instance_resolution = "not_applicable"
        return {
            "selected_candidate": selected,
            "selected_node_id": selected_node_id,
            "selected_candidate_rank": rank,
            "selected_fault_mode": fault_mode,
            "most_likely_reason": "；".join(reason_items) or reason,
            "most_likely_reasons": reason_items,
            "troubleshooting_methods": steps,
            "troubleshooting_checks": checks,
            "selected_node_runtime": self._public_runtime(selected_node.get("runtime")),
            "root_scope": root_scope,
            "instance_resolution": instance_resolution,
            "possible_member_nodes": possible_members,
            "member_resolution_warning": member_resolution_warning,
            "resolved_from_aggregate": (
                {
                    "node_id": promoted_from_node_id,
                    "name": catalog["by_id"].get(promoted_from_node_id, {}).get("name")
                    or promoted_from_node_id,
                }
                if promoted_from_node_id
                else None
            ),
            "propagation_path": display_chain,
            "display_chain": display_chain,
            "confidence": parsed.get("confidence", fallback.get("confidence")),
            "notes": self._normalize_steps(parsed.get("notes")),
            "path_validation_warnings": list(dict.fromkeys([*path_warnings, *check_warnings])),
        }

    def _fallback_decision(self, analysis: dict[str, Any], source: str) -> dict[str, Any]:
        hypotheses = analysis.get("hypotheses") if isinstance(analysis.get("hypotheses"), list) else []
        top = hypotheses[0] if hypotheses and isinstance(hypotheses[0], dict) else {}
        steps = self._steps_from_validation(top.get("validation_suggestions") or [])
        if not steps:
            steps = self._normalize_steps(top.get("missing_evidence") or [])
        if not steps:
            steps = ["补充日志、监控和组件健康状态，核对候选根因与故障时间窗口是否一致。"]
        reason = str(top.get("summary") or analysis.get("decision") or "").strip()
        return {
            "selected_candidate": str(top.get("candidate") or ""),
            "selected_candidate_rank": self._safe_int(top.get("rank")) or 0,
            "selected_fault_mode": str(top.get("fault_mode") or ""),
            "most_likely_reason": reason,
            "most_likely_reasons": [reason] if reason else [],
            "troubleshooting_methods": steps,
            "display_chain": self._normalize_display_chain(None, top),
            "confidence": top.get("confidence"),
            "source": source,
            "model_config_id": str(getattr(self.settings, "rca_decision_model_config_id", "") or ""),
            "conversation_id": "",
            "raw_content": "",
        }

    def _ground_fallback_in_architecture(
        self,
        fallback: dict[str, Any],
        architecture: Any | None,
        detail: dict[str, Any],
    ) -> dict[str, Any]:
        catalog = self._architecture_catalog(architecture)
        selected_node_id = self._resolve_catalog_node_id(fallback.get("selected_candidate"), catalog)
        if not selected_node_id:
            return fallback
        promoted_from_node_id = ""
        initial_node = catalog["by_id"].get(selected_node_id, {})
        initial_members = self._possible_member_nodes(selected_node_id, catalog, detail)
        if (
            str(initial_node.get("kind") or "") not in {"Instance", "Host", "VM", "Pod"}
            and len(initial_members) == 1
        ):
            promoted_from_node_id = selected_node_id
            selected_node_id = str(initial_members[0].get("node_id") or selected_node_id)
        selected_node = catalog["by_id"].get(selected_node_id, {})
        path, warnings = self._normalize_architecture_path(
            fallback.get("display_chain"),
            selected_node_id,
            catalog,
        )
        possible_members = self._possible_member_nodes(selected_node_id, catalog, detail)
        steps = list(fallback.get("troubleshooting_methods") or [])
        reasons = list(fallback.get("most_likely_reasons") or [])
        if promoted_from_node_id:
            aggregate_name = str(
                catalog["by_id"].get(promoted_from_node_id, {}).get("name")
                or promoted_from_node_id
            )
            target = self._node_target_summary(selected_node)
            reasons.insert(
                0,
                f"“{aggregate_name}”仅关联一个真实实例，实际排查目标已收敛到"
                f"“{selected_node.get('name') or selected_node_id}”。",
            )
            step = f"直接检查唯一真实实例“{selected_node.get('name') or selected_node_id}”"
            if target:
                step += f"（{target}）"
            steps.insert(0, step + "的健康状态、限流指标、网络连通性和实例日志。")
        if possible_members:
            steps.append(
                "当前证据只能定位到集群，无法确认具体故障实例；请按待排查成员清单逐一检查"
                "节点健康、集群角色、网络连通性和实例日志。"
            )
        member_resolution_warning = ""
        selected_is_instance = str(selected_node.get("kind") or "") in {"Instance", "Host", "VM", "Pod"}
        if not possible_members and not selected_is_instance and self._looks_like_aggregate(selected_node):
            member_resolution_warning = (
                f"架构图谱中未找到聚合节点“{selected_node.get('name') or selected_node_id}”的实例成员关系，"
                "无法生成待排查实例；请补充 HAS_MEMBER、CONTAINS、BELONGS_TO 或 MEMBER_OF 关系。"
            )
            steps.append(member_resolution_warning)
            warnings.append(member_resolution_warning)
        return {
            **fallback,
            "selected_node_id": selected_node_id,
            "selected_candidate": str(selected_node.get("name") or selected_node_id),
            "selected_node_runtime": self._public_runtime(selected_node.get("runtime")),
            "most_likely_reasons": reasons[:8],
            "most_likely_reason": "；".join(reasons[:8]),
            "root_scope": "cluster" if possible_members or member_resolution_warning else (
                "instance"
                if selected_is_instance
                else "component"
            ),
            "instance_resolution": (
                "unresolved_members_listed"
                if possible_members
                else "members_missing"
                if member_resolution_warning
                else "resolved_instance"
                if selected_is_instance
                else "not_applicable"
            ),
            "possible_member_nodes": possible_members,
            "member_resolution_warning": member_resolution_warning,
            "resolved_from_aggregate": (
                {
                    "node_id": promoted_from_node_id,
                    "name": catalog["by_id"].get(promoted_from_node_id, {}).get("name")
                    or promoted_from_node_id,
                }
                if promoted_from_node_id
                else None
            ),
            "troubleshooting_methods": list(dict.fromkeys(steps))[:12],
            "propagation_path": path,
            "display_chain": path or fallback.get("display_chain") or [],
            "path_validation_warnings": warnings,
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

    def _normalize_troubleshooting_checks(
        self,
        value: Any,
        catalog: dict[str, Any],
        default_node_id: str,
    ) -> tuple[list[dict[str, Any]], list[str]]:
        """Ground model-authored checks in trusted architecture metadata.

        The model chooses a node and an action.  Addresses shown to users are
        always copied from the catalog; a model-supplied unknown IP or port is
        never accepted as an operational target.
        """
        if isinstance(value, dict):
            raw_items = [value]
        elif isinstance(value, list):
            raw_items = value
        else:
            return [], []

        checks: list[dict[str, Any]] = []
        warnings: list[str] = []
        for raw in raw_items[:8]:
            if not isinstance(raw, dict):
                continue
            supplied_node = raw.get("node_id") or raw.get("n") or raw.get("node") or raw.get("name")
            node_id = self._resolve_catalog_node_id(supplied_node, catalog) if supplied_node else default_node_id
            if not node_id or node_id not in catalog["by_id"]:
                warnings.append(f"忽略未绑定到真实架构节点的排查步骤：{supplied_node or '-'}")
                continue
            node = catalog["by_id"][node_id]
            action = str(
                raw.get("action")
                or raw.get("a")
                or raw.get("step")
                or raw.get("title")
                or raw.get("method")
                or raw.get("description")
                or raw.get("reason")
                or ""
            ).strip()[:500]
            if not action:
                continue

            requested_fields = self._normalize_target_fields(
                raw.get("target_fields") or raw.get("fields") or raw.get("f")
            )
            runtime = node.get("runtime") if isinstance(node.get("runtime"), dict) else {}
            if requested_fields:
                target = {key: runtime[key] for key in requested_fields if runtime.get(key)}
            else:
                defaults = ("endpoints", "ips", "hostnames", "ports", "instance_ids", "pods", "namespaces")
                target = {key: runtime[key] for key in defaults if runtime.get(key)}

            target_summary = self._runtime_target_summary(target)
            command_template = str(raw.get("command_template") or raw.get("command") or raw.get("cmd") or "").strip()
            command, command_warning = self._render_trusted_command(command_template, node)
            if command_warning:
                warnings.append(command_warning)
            expected = str(raw.get("expected_result") or raw.get("expected") or raw.get("expect") or "").strip()[:300]

            display = action
            if target_summary and target_summary not in display:
                display = f"{action}；目标：{node['name']}（{target_summary}）"
            elif node["name"] not in display:
                display = f"{action}；节点：{node['name']}"
            if command:
                display += f"；参考命令：{command}"
            if expected:
                display += f"；预期：{expected}"

            check: dict[str, Any] = {
                "node_id": node_id,
                "node": node["name"],
                "action": action,
                "target": self._public_runtime(target),
                "display": display[:1200],
            }
            if command:
                check["command"] = command
            if expected:
                check["expected_result"] = expected
            checks.append(check)
        return checks, list(dict.fromkeys(warnings))

    def _normalize_target_fields(self, value: Any) -> list[str]:
        values = value if isinstance(value, list) else re.split(r"[,，;；\s]+", str(value or ""))
        result: list[str] = []
        for item in values:
            field = _TARGET_FIELD_ALIASES.get(str(item or "").strip().casefold(), "")
            if field and field not in result:
                result.append(field)
        return result

    def _render_trusted_command(self, template: str, node: dict[str, Any]) -> tuple[str, str]:
        if not template:
            return "", ""
        runtime = node.get("runtime") if isinstance(node.get("runtime"), dict) else {}
        ips = [str(item) for item in runtime.get("ips") or []]
        hosts = [str(item) for item in runtime.get("hostnames") or []]
        ports = [str(item) for item in runtime.get("ports") or []]
        endpoints = [str(item) for item in runtime.get("endpoints") or []]
        command = template[:600]
        replacements = {
            "{host}": (ips or hosts or [""])[0],
            "{ip}": (ips or [""])[0],
            "{port}": (ports or [""])[0],
            "{endpoint}": (endpoints or [self._node_target_summary(node) or ""])[0],
            "{node}": str(node.get("name") or ""),
        }
        for marker, replacement in replacements.items():
            command = command.replace(marker, replacement)
        if re.search(r"\{(?:host|ip|port|endpoint|node)\}", command):
            return "", f"节点 {node.get('name')} 缺少命令模板需要的运行元数据，已隐藏参考命令"

        known_ips = set(ips)
        unknown_ips = [item for item in _IPV4_RE.findall(command) if item not in known_ips]
        if unknown_ips:
            return "", f"排查命令包含未登记 IP {unknown_ips[0]}，已隐藏参考命令"
        known_hosts = set(ips) | set(hosts)
        for endpoint in endpoints:
            try:
                parsed_endpoint = urlsplit(endpoint)
            except ValueError:
                parsed_endpoint = None
            if parsed_endpoint and parsed_endpoint.hostname:
                known_hosts.add(parsed_endpoint.hostname)
            else:
                known_hosts.add(endpoint.rsplit(":", 1)[0])
        mentioned_hosts = set(
            re.findall(r"(?i)(?:-h\s+|--host(?:=|\s+))([a-z0-9][a-z0-9._-]*)", command)
        )
        for mentioned_endpoint in _ENDPOINT_RE.findall(command):
            try:
                parsed_endpoint = urlsplit(mentioned_endpoint)
            except ValueError:
                parsed_endpoint = None
            if parsed_endpoint and parsed_endpoint.hostname:
                mentioned_hosts.add(parsed_endpoint.hostname)
            elif ":" in mentioned_endpoint:
                mentioned_hosts.add(mentioned_endpoint.rsplit(":", 1)[0])
        unknown_hosts = sorted(host for host in mentioned_hosts if host not in known_hosts)
        if unknown_hosts:
            return "", f"排查命令包含未登记主机 {unknown_hosts[0]}，已隐藏参考命令"
        known_ports = set(ports)
        mentioned_ports = set(re.findall(r"(?i)(?:-p|--port(?:=|\s+)|:)(\d{2,5})(?!\d)", command))
        if mentioned_ports and not mentioned_ports.issubset(known_ports):
            unknown = min(mentioned_ports - known_ports)
            return "", f"排查命令包含未登记端口 {unknown}，已隐藏参考命令"
        return command[:500], ""

    def _public_runtime(self, runtime: Any) -> dict[str, list[Any]]:
        if not isinstance(runtime, dict):
            return {}
        return {
            str(key): list(value)[:8]
            for key, value in runtime.items()
            if isinstance(value, list) and value
        }

    def _possible_member_nodes(
        self,
        selected_node_id: str,
        catalog: dict[str, Any],
        detail: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """Expand a cluster conclusion into real, non-asserted member candidates."""
        if not selected_node_id or selected_node_id not in catalog.get("by_id", {}):
            return []

        outgoing = self._membership_children(catalog)
        if selected_node_id not in outgoing:
            return []

        physical_kinds = {"Instance", "Host", "VM", "Pod"}
        nested_kinds = {"Cluster", "Cache", "Database", "Middleware", "Queue", "Component"}
        queue: list[tuple[str, int, list[str]]] = [(selected_node_id, 0, [selected_node_id])]
        visited = {selected_node_id}
        candidates: list[dict[str, Any]] = []

        while queue:
            parent_id, depth, path = queue.pop(0)
            parent = catalog["by_id"].get(parent_id, {})
            for edge in outgoing.get(parent_id, []):
                relation = str(edge.get("type") or "").upper()
                target_id = str(edge.get("target_node_id") or "")
                target = catalog["by_id"].get(target_id)
                if not target or target_id in visited:
                    continue
                # CONTAINS is also used for page/system hierarchy.  Only treat
                # it as membership below a cluster-like node and never expand
                # UI/layer/function entities as operational instances.
                parent_kind = str(parent.get("kind") or "")
                if relation == "CONTAINS" and parent_kind in {"System", "Layer", "Function", "UIControl", "UIFunction"}:
                    continue
                visited.add(target_id)
                runtime = target.get("runtime") if isinstance(target.get("runtime"), dict) else {}
                has_operational_target = bool(
                    runtime.get("ips")
                    or runtime.get("hostnames")
                    or runtime.get("endpoints")
                    or runtime.get("instance_ids")
                    or runtime.get("pods")
                )
                target_kind = str(target.get("kind") or "")
                is_concrete_member = target_kind in physical_kinds or (
                    relation in {"HAS_MEMBER", "BELONGS_TO", "MEMBER_OF"}
                    and has_operational_target
                    and target_kind not in {"Cluster", "System", "Layer", "Function", "API", "UIControl", "UIFunction"}
                ) or (
                    relation == "CONTAINS"
                    and has_operational_target
                    and parent_kind not in {"System", "Layer"}
                    and target_kind not in {"Cluster", "System", "Layer", "Function", "API", "UIControl", "UIFunction"}
                )
                member_path = [*path, target_id]
                if is_concrete_member:
                    matched = self._matched_node_identifier(target, detail)
                    target_summary = self._node_target_summary(target)
                    public_runtime = self._public_runtime(runtime)
                    candidates.append(
                        {
                            "node_id": target_id,
                            "name": target.get("name") or target_id,
                            "kind": target_kind or "Instance",
                            "runtime": public_runtime,
                            "ips": list(public_runtime.get("ips") or []),
                            "ports": list(public_runtime.get("ports") or []),
                            "target": target_summary,
                            "status": "priority_check" if matched else "needs_investigation",
                            "possibility": "evidence_matched" if matched else "undetermined",
                            "direct_evidence": bool(matched),
                            "matched_identifier": matched,
                            "metadata_status": "complete" if target_summary else "missing_endpoint",
                            "reason": (
                                f"日志中出现该实例标识“{matched}”，应优先核查。"
                                if matched
                                else f"属于根因集群“{catalog['by_id'][selected_node_id]['name']}”，"
                                "当前没有实例级直接证据，列为待排查成员。"
                            ),
                            "membership_path": member_path,
                        }
                    )
                if target_id in outgoing and (target_kind in nested_kinds or not is_concrete_member):
                    queue.append((target_id, depth + 1, member_path))

        candidates.sort(
            key=lambda item: (
                not bool(item.get("direct_evidence")),
                str(item.get("name") or "").casefold(),
            )
        )
        return candidates

    def _membership_children(self, catalog: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
        """Normalize both aggregate→member and member→aggregate edge conventions."""
        children: dict[str, list[dict[str, Any]]] = {}
        for edge in catalog.get("edges") or []:
            relation = str(edge.get("type") or "").upper()
            source = str(edge.get("source_node_id") or "")
            target = str(edge.get("target_node_id") or "")
            if not source or not target:
                continue
            if relation in {"HAS_MEMBER", "CONTAINS"}:
                parent_id, child_id = source, target
            elif relation in {"BELONGS_TO", "MEMBER_OF"}:
                parent_id, child_id = target, source
            else:
                continue
            children.setdefault(parent_id, []).append(
                {
                    **edge,
                    "source_node_id": parent_id,
                    "target_node_id": child_id,
                    "type": relation,
                }
            )
        return children

    def _looks_like_aggregate(self, node: dict[str, Any]) -> bool:
        kind = str(node.get("kind") or "")
        if kind == "Cluster":
            return True
        name = str(node.get("name") or "").casefold()
        return kind in {"Cache", "Database", "Middleware", "Queue", "Component", "Service"} and bool(
            re.search(r"(?:cluster|集群|节点组|实例组|组件组)", name)
        )

    def _enforce_cluster_scope(
        self,
        selected_node_id: str,
        catalog: dict[str, Any],
        analysis: dict[str, Any],
        detail: dict[str, Any],
    ) -> tuple[str, str, str]:
        """Prevent an ungrounded model guess from promoting a cluster member."""
        selected = catalog.get("by_id", {}).get(selected_node_id, {})
        if str(selected.get("kind") or "") not in {"Instance", "Host", "VM", "Pod"}:
            return selected_node_id, "", ""
        if self._matched_node_identifier(selected, detail):
            return selected_node_id, "", ""

        membership = self._membership_children(catalog)
        parent_ids = {
            parent_id
            for parent_id, children in membership.items()
            if any(str(edge.get("target_node_id") or "") == selected_node_id for edge in children)
        }
        if not parent_ids:
            return selected_node_id, "", ""
        algorithm_candidates: list[Any] = []
        hypotheses = analysis.get("hypotheses") if isinstance(analysis.get("hypotheses"), list) else []
        for hypothesis in hypotheses:
            if isinstance(hypothesis, dict):
                algorithm_candidates.append(hypothesis.get("candidate"))
        for candidate in algorithm_candidates:
            parent_id = self._resolve_catalog_node_id(candidate, catalog)
            if parent_id in parent_ids:
                parent = catalog["by_id"].get(parent_id, {})
                members = self._possible_member_nodes(parent_id, catalog, detail)
                if len(members) == 1 and members[0].get("node_id") == selected_node_id:
                    return selected_node_id, "", ""
                return (
                    parent_id,
                    selected_node_id,
                    f"日志缺少实例“{selected.get('name')}”的直接标识，已保留算法定位的集群"
                    f"“{parent.get('name')}”为正式根因，并将实例降为待排查成员。",
                )
        return selected_node_id, "", ""

    def _matched_node_identifier(self, node: dict[str, Any], detail: dict[str, Any]) -> str:
        log_text = "\n".join(self._text_values(detail)).casefold()
        if not log_text:
            return ""
        runtime = node.get("runtime") if isinstance(node.get("runtime"), dict) else {}
        identifiers = [str(node.get("name") or "").strip()]
        for key in (
            "aliases",
            "hostnames",
            "ips",
            "endpoints",
            "instance_ids",
            "pods",
        ):
            identifiers.extend(str(item).strip() for item in runtime.get(key) or [])
        return next(
            (
                item
                for item in identifiers
                if len(item) >= 3 and item.casefold() in log_text
            ),
            "",
        )

    def _node_target_summary(self, node: dict[str, Any]) -> str:
        runtime = node.get("runtime") if isinstance(node.get("runtime"), dict) else {}
        return self._runtime_target_summary(runtime)

    def _runtime_target_summary(self, runtime: dict[str, Any]) -> str:
        endpoints = [str(item) for item in runtime.get("endpoints") or [] if str(item).strip()]
        if endpoints:
            return "、".join(endpoints[:4])
        hosts = [str(item) for item in (runtime.get("ips") or runtime.get("hostnames") or []) if str(item).strip()]
        ports = [str(item) for item in runtime.get("ports") or [] if str(item).strip()]
        if hosts and ports:
            if len(hosts) == len(ports):
                pairs = [f"{host}:{port}" for host, port in zip(hosts, ports)]
            else:
                pairs = [f"{host}:{ports[0]}" for host in hosts]
            return "、".join(pairs[:4])
        if hosts:
            return "、".join(hosts[:4])
        if ports:
            return "端口 " + "、".join(ports[:4])
        for key in ("instance_ids", "pods", "clusters", "namespaces", "health_checks"):
            values = [str(item) for item in runtime.get(key) or [] if str(item).strip()]
            if values:
                return "、".join(values[:4])
        return ""

    def _build_prompt(self, detail: dict[str, Any], analysis: dict[str, Any]) -> str:
        prompt, _ = self._build_prompt_with_meta(detail, analysis)
        return prompt

    def _build_prompt_with_meta(
        self,
        detail: dict[str, Any],
        analysis: dict[str, Any],
        architecture: Any | None = None,
    ) -> tuple[str, dict[str, Any]]:
        timeline = detail.get("timeline") if isinstance(detail.get("timeline"), list) else []
        evidence = {
            "root_service_candidate": detail.get("root_service_candidate"),
            "root_cause_candidate": detail.get("root_cause_candidate"),
            "root_evidence": detail.get("root_evidence"),
        }
        if self.log_compressor.config.enabled:
            log_context = self.log_compressor.compress(timeline, root_evidence=evidence)
        else:
            limit = min(20, max(1, self.log_compressor.config.max_events))
            key_events = [self._compact_value(item) for item in timeline[:limit]]
            log_context = {
                "summary": {
                    "compression_enabled": False,
                    "original_events": len(timeline),
                    "selected_events": len(key_events),
                    "omitted_events": max(0, len(timeline) - len(key_events)),
                },
                "key_events": key_events,
                "repeated_patterns": [],
            }

        catalog = self._architecture_catalog(architecture)
        architecture_data = self._compact_architecture_prompt(catalog)
        graph_fingerprint = self._architecture_fingerprint(catalog)

        prompt_data = {
            "architecture_graph": architecture_data,
            "architecture_focus": self._architecture_focus_prompt_data(catalog, detail, analysis),
            "incident": {
                "incident_id": detail.get("incident_id") or analysis.get("incident_id"),
                "root_service_candidate": detail.get("root_service_candidate"),
                "root_cause_candidate": detail.get("root_cause_candidate"),
                "root_evidence": self._compact_value(detail.get("root_evidence")),
                "candidate_reason_logs": self._compact_value(detail.get("root_candidates") or []),
                "upstream_effect_logs": self._compact_value(detail.get("upstream_effects") or []),
                "fault_start": detail.get("fault_start"),
                "fault_end": detail.get("fault_end"),
                "observed_entities": self._extract_log_entities(detail, timeline),
                "log_context": log_context,
            },
            "algorithm_candidates": {
                "decision": analysis.get("decision"),
                "resolved_root_service": analysis.get("resolved_root_service"),
                "hypotheses": self._compact_hypotheses(analysis.get("hypotheses")),
                "limitations": self._compact_value(analysis.get("limitations") or []),
            },
        }
        prompt = (
            "你是生产故障RCA决策助手。architecture_graph是本项目架构的唯一实体和关系来源。"
            "architecture_graph包含本次请求独立使用的完整紧凑架构，不得依赖其他请求的会话上下文补全图谱。"
            "紧凑格式：n节点=[id,name,type,meta]，e关系=[sourceId,targetId,relation,meta]；"
            "type和relation缩写见schema，meta字段见schema.m。architecture_focus仅补充本次候选节点描述。"
            "请结合候选原因日志、架构节点及边判断根因并组织传播路径，不得编造节点、ID、关系、IP、端口或日志证据。\n"
            "incident.log_context 已经过确定性日志压缩：key_events 是按严重度、异常信号、稀有度、"
            "服务/trace 多样性和故障邻域筛选的关键事件；repeated_patterns 汇总被折叠的重复日志。\n"
            "决策约束（按优先级）：\n"
            "1.selected_node_id必须来自architecture_graph.n[][0]；节点名称只能取同一行的name。\n"
            "2. propagation_path 按‘根因 → 故障传播节点 → 受影响入口’排序，每个 node_id 必须真实存在。\n"
            "3.路径中相邻节点必须由architecture_graph.e中的边直接连接；边方向表示系统依赖，传播方向可与依赖方向相反。\n"
            "4. algorithm_candidates 只是辅助证据，可以纠正其候选名称和链路，但结论必须落在架构节点上。\n"
            "5.根因依据、排查步骤、selected_node_id和propagation_path必须指向同一根因。\n"
            "6.checks必须绑定真实node_id；target_fields只能使用ip、p、h、ep、ins、pod、ns等已提供字段。"
            "命令只写含{host}/{ip}/{port}/{endpoint}/{node}占位符的command_template，实际地址由服务端填充。\n"
            "7.若日志证据只能定位到集群，selected_node_id必须选择集群节点，不得猜测某个成员实例为根因；"
            "服务端会根据HAS_MEMBER/CONTAINS/BELONGS_TO/MEMBER_OF关系展开全部真实成员作为待排查清单。"
            "若逻辑聚合节点只有一个真实实例，正式根因应直接选择该实例；只有多个实例且无法区分时才保留聚合节点。\n"
            "请严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。JSON 格式：\n"
            "{"
            '"selected_node_id":"architecture_graph 中真实 node_id",'
            '"selected_candidate":"该 node_id 对应的真实 name",'
            '"selected_candidate_rank":1,'
            '"selected_fault_mode":"故障模式",'
            '"most_likely_reasons":["根因依据1","根因依据2","根因依据3"],'
            '"checks":[{"node_id":"真实node_id","action":"排查动作","target_fields":["ip","p"],"command_template":"使用占位符的可选命令","expected_result":"预期结果"}],'
            '"propagation_path":[{"node_id":"真实 node_id","label":"面向用户的简短名称","stage":"根因/故障传播/受影响入口","explanation":"该节点在传播链中的作用"}],'
            '"confidence":0.0,'
            '"notes":["需要补充的证据或注意点"]'
            "}\n"
            "propagation_path 的第一个节点必须等于 selected_node_id；label 和 explanation 应使用业务人员容易理解的中文，"
            "并与根因依据和排查步骤保持一致。若架构图中不存在日志提到的组件，不得编造该组件；请在 notes 中说明缺失。\n"
            f"输入数据：{json.dumps(self._drop_empty(prompt_data), ensure_ascii=False, separators=(',', ':'))}"
        )
        summary = dict(log_context.get("summary") or {})
        summary["architecture"] = {
            "fingerprint": graph_fingerprint,
            "included": True,
            "nodes": len(catalog["nodes"]),
            "edges": len(catalog["edges"]),
        }
        return prompt, summary

    def _architecture_prompt_data(self, architecture: Any | None) -> dict[str, Any]:
        catalog = self._architecture_catalog(architecture)
        return self._compact_architecture_prompt(catalog)

    def _architecture_catalog(self, architecture: Any | None) -> dict[str, Any]:
        raw_nodes = getattr(architecture, "nodes", None)
        raw_edges = getattr(architecture, "edges", None)
        if isinstance(architecture, dict):
            raw_nodes = architecture.get("nodes")
            raw_edges = architecture.get("edges")
        nodes: list[dict[str, Any]] = []
        by_id: dict[str, dict[str, Any]] = {}
        name_to_id: dict[str, str] = {}
        alias_to_id: dict[str, str] = {}
        for raw in raw_nodes or []:
            data = raw if isinstance(raw, dict) else getattr(raw, "model_dump", lambda: {})()
            name = str(data.get("name") or "").strip()
            node_id = str(data.get("id") or name).strip()
            if not name or not node_id or node_id in by_id:
                continue
            meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
            runtime = self._safe_runtime_meta(meta)
            aliases = list(runtime.get("aliases") or [])
            node = {
                "node_id": node_id,
                "name": name,
                "aliases": aliases,
                "kind": str(data.get("kind") or "Component"),
                "type": self._kind_code(str(data.get("kind") or "Component")),
                "description": self._safe_description(data.get("description"), 240),
                "runtime": runtime,
            }
            nodes.append(node)
            by_id[node_id] = node
            name_to_id[name] = node_id
            runtime_identifiers: list[Any] = []
            for key in ("aliases", "hostnames", "ips", "endpoints", "instance_ids", "service_names", "pods"):
                runtime_identifiers.extend(runtime.get(key) or [])
            for identifier in [node_id, name, *runtime_identifiers]:
                alias_to_id.setdefault(str(identifier).strip().casefold(), node_id)

        edges: list[dict[str, Any]] = []
        adjacency: dict[str, set[str]] = {node_id: set() for node_id in by_id}
        for raw in raw_edges or []:
            data = raw if isinstance(raw, dict) else getattr(raw, "model_dump", lambda: {})()
            source = name_to_id.get(str(data.get("source") or ""), str(data.get("source") or ""))
            target = name_to_id.get(str(data.get("target") or ""), str(data.get("target") or ""))
            if source not in by_id or target not in by_id or source == target:
                continue
            meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
            connection = self._safe_runtime_meta(meta, edge=True)
            relation = str(data.get("type") or "CALLS").upper()
            edges.append({
                "source_node_id": source,
                "target_node_id": target,
                "type": relation,
                "relation": _RELATION_CODES.get(relation, relation[:12]),
                "description": self._safe_description(data.get("description"), 160),
                "runtime": connection,
            })
            adjacency[source].add(target)
            adjacency[target].add(source)
        return {
            "nodes": nodes,
            "edges": edges,
            "by_id": by_id,
            "alias_to_id": alias_to_id,
            "adjacency": adjacency,
        }

    def _compact_architecture_prompt(self, catalog: dict[str, Any]) -> dict[str, Any]:
        nodes: list[list[Any]] = []
        used_types: set[str] = set()
        for node in catalog["nodes"]:
            node_type = str(node.get("type") or "CP")
            used_types.add(node_type)
            row: list[Any] = [node["node_id"], node["name"], node_type]
            runtime = self._compact_runtime(node.get("runtime"), node.get("name"))
            if runtime:
                row.append(runtime)
            nodes.append(row)

        edges: list[list[Any]] = []
        used_relations: set[str] = set()
        for edge in catalog["edges"]:
            relation = str(edge.get("relation") or edge.get("type") or "C")
            used_relations.add(relation)
            row = [edge["source_node_id"], edge["target_node_id"], relation]
            runtime = self._compact_runtime(edge.get("runtime"))
            if runtime:
                row.append(runtime)
            edges.append(row)

        kind_legend = {
            str(node.get("type") or "CP"): str(node.get("kind") or "Component")
            for node in catalog["nodes"]
            if str(node.get("type") or "CP") in used_types
        }
        relation_legend = {
            str(edge.get("relation") or edge.get("type") or "C"): str(edge.get("type") or "CALLS")
            for edge in catalog["edges"]
            if str(edge.get("relation") or edge.get("type") or "C") in used_relations
        }
        return {
            "ref": self._architecture_fingerprint(catalog),
            "schema": {
                "n": ["id", "name", "t", "m?"],
                "e": ["sourceId", "targetId", "r", "m?"],
                "t": kind_legend,
                "r": relation_legend,
                "m": {short: full for full, short in _RUNTIME_PROMPT_KEYS.items()},
            },
            "n": nodes,
            "e": edges,
        }

    def _architecture_focus_prompt_data(
        self,
        catalog: dict[str, Any],
        detail: dict[str, Any],
        analysis: dict[str, Any],
    ) -> dict[str, Any]:
        values: list[Any] = [
            detail.get("root_service_candidate"),
            analysis.get("resolved_root_service"),
        ]
        hypotheses = analysis.get("hypotheses") if isinstance(analysis.get("hypotheses"), list) else []
        for item in hypotheses[:8]:
            if not isinstance(item, dict):
                continue
            values.append(item.get("candidate"))
            values.extend(item.get("chain") if isinstance(item.get("chain"), list) else [])
        focus_ids = {
            node_id
            for value in values
            if (node_id := self._resolve_catalog_node_id(value, catalog))
        }
        for node_id in list(focus_ids):
            focus_ids.update(catalog["adjacency"].get(node_id, set()))
        descriptions = [
            [node_id, catalog["by_id"][node_id]["description"]]
            for node_id in sorted(focus_ids)
            if catalog["by_id"][node_id].get("description")
        ]
        return {"d": descriptions[:40]} if descriptions else {}

    def _architecture_fingerprint(self, catalog: dict[str, Any]) -> str:
        canonical = {
            "n": [
                [
                    node.get("node_id"),
                    node.get("name"),
                    node.get("type"),
                    node.get("runtime"),
                    node.get("description"),
                ]
                for node in catalog.get("nodes") or []
            ],
            "e": [
                [
                    edge.get("source_node_id"),
                    edge.get("target_node_id"),
                    edge.get("relation"),
                    edge.get("runtime"),
                    edge.get("description"),
                ]
                for edge in catalog.get("edges") or []
            ],
        }
        encoded = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:16]

    def _kind_code(self, kind: str) -> str:
        text = str(kind or "Component").strip()
        return _KIND_CODES.get(text, re.sub(r"[^A-Za-z0-9]", "", text).upper()[:8] or "CP")

    def _safe_runtime_meta(self, meta: dict[str, Any], *, edge: bool = False) -> dict[str, list[Any]]:
        runtime: dict[str, list[Any]] = {}
        edge_fields = {"hostnames", "ips", "ports", "endpoints", "protocols", "health_checks"}
        for canonical, _short, source_keys in _RUNTIME_META_FIELDS:
            if edge and canonical not in edge_fields:
                continue
            values: list[Any] = []
            for key in source_keys:
                values.extend(self._meta_values(meta.get(key), canonical))
            deduped: list[Any] = []
            for value in values:
                marker = str(value).casefold()
                if marker and all(str(existing).casefold() != marker for existing in deduped):
                    deduped.append(value)
            if deduped:
                runtime[canonical] = deduped[:8]
        return runtime

    def _meta_values(self, value: Any, field: str) -> list[Any]:
        if value is None:
            return []
        if isinstance(value, (list, tuple, set)):
            result: list[Any] = []
            for item in value:
                result.extend(self._meta_values(item, field))
            return result
        if isinstance(value, dict):
            return []
        sanitized = self._sanitize_meta_scalar(value, field)
        return [sanitized] if sanitized not in (None, "") else []

    def _sanitize_meta_scalar(self, value: Any, field: str) -> Any:
        if field == "ports":
            try:
                port = int(value)
            except (TypeError, ValueError):
                return None
            return port if 1 <= port <= 65535 else None
        text = re.sub(r"\s+", " ", str(value or "")).strip()
        if not text:
            return None
        if field == "ips":
            try:
                return str(ipaddress.ip_address(text))
            except ValueError:
                return None
        if field in {"endpoints", "health_checks"}:
            text = self._sanitize_endpoint(text)
        if re.search(r"(?i)(?:password|passwd|token|secret|private[_-]?key|access[_-]?key)\s*[=:]", text):
            return None
        return text[:300]

    def _sanitize_endpoint(self, value: str) -> str:
        text = str(value or "").strip()[:500]
        if not text:
            return ""
        try:
            parsed = urlsplit(text)
        except ValueError:
            parsed = None
        if parsed and parsed.scheme and parsed.hostname:
            host = parsed.hostname
            if ":" in host and not host.startswith("["):
                host = f"[{host}]"
            try:
                port = parsed.port
            except ValueError:
                return ""
            netloc = f"{host}:{port}" if port else host
            return urlunsplit((parsed.scheme, netloc, parsed.path, "", ""))[:300]
        text = text.split("?", 1)[0].split("#", 1)[0]
        if "@" in text:
            text = text.rsplit("@", 1)[-1]
        return text[:300]

    def _safe_description(self, value: Any, limit: int) -> str:
        text = re.sub(r"\s+", " ", str(value or "")).strip()
        text = re.sub(
            r"(?i)\b(password|passwd|token|secret|private[_-]?key|access[_-]?key)\s*[=:]\s*[^\s,;]+",
            r"\1=<redacted>",
            text,
        )
        return text[:limit]

    def _compact_runtime(self, runtime: Any, node_name: Any = "") -> dict[str, list[Any]]:
        if not isinstance(runtime, dict):
            return {}
        name = str(node_name or "").strip().casefold()
        result: dict[str, list[Any]] = {}
        for full, short in _RUNTIME_PROMPT_KEYS.items():
            values = list(runtime.get(full) or [])[:8]
            if full in {"aliases", "service_names"} and name:
                values = [item for item in values if str(item).strip().casefold() != name]
            if values:
                result[short] = values
        return result

    def _extract_log_entities(self, detail: dict[str, Any], timeline: list[Any]) -> dict[str, list[str]]:
        values: list[str] = []
        for source in (
            detail.get("root_evidence"),
            detail.get("root_candidates"),
            detail.get("upstream_effects"),
            timeline[:120],
        ):
            values.extend(self._text_values(source))
        ips: list[str] = []
        endpoints: list[str] = []
        for text in values:
            for raw_ip in _IPV4_RE.findall(text):
                try:
                    ip = str(ipaddress.ip_address(raw_ip))
                except ValueError:
                    continue
                if ip not in ips:
                    ips.append(ip)
            for raw_endpoint in _ENDPOINT_RE.findall(text):
                endpoint = self._sanitize_endpoint(raw_endpoint.rstrip("/).]}'\""))
                if endpoint and endpoint not in endpoints:
                    endpoints.append(endpoint)
        result: dict[str, list[str]] = {}
        if ips:
            result["ip"] = ips[:24]
        if endpoints:
            result["ep"] = endpoints[:24]
        return result

    def _text_values(self, value: Any, depth: int = 0) -> list[str]:
        if depth > 3 or value is None:
            return []
        if isinstance(value, str):
            return [value[:4000]]
        if isinstance(value, dict):
            result: list[str] = []
            for item in list(value.values())[:24]:
                result.extend(self._text_values(item, depth + 1))
            return result
        if isinstance(value, (list, tuple)):
            result: list[str] = []
            for item in list(value)[:120]:
                result.extend(self._text_values(item, depth + 1))
            return result
        return [str(value)]

    def _drop_empty(self, value: Any) -> Any:
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                compact = self._drop_empty(item)
                if compact not in (None, "", [], {}):
                    result[key] = compact
            return result
        if isinstance(value, list):
            return [self._drop_empty(item) for item in value]
        return value

    def _resolve_catalog_node_id(self, value: Any, catalog: dict[str, Any]) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        if text in catalog["by_id"]:
            return text
        return str(catalog["alias_to_id"].get(text.casefold()) or "")

    def _normalize_architecture_path(
        self,
        value: Any,
        selected_node_id: str,
        catalog: dict[str, Any],
    ) -> tuple[list[dict[str, str]], list[str]]:
        if not catalog["by_id"]:
            return [], []
        proposed: dict[str, dict[str, str]] = {}
        requested: list[str] = []
        warnings: list[str] = []
        for raw in value if isinstance(value, list) else []:
            item = raw if isinstance(raw, dict) else {"node_id": raw}
            node_id = self._resolve_catalog_node_id(
                item.get("node_id") or item.get("node") or item.get("name"),
                catalog,
            )
            if not node_id:
                warnings.append(f"忽略不存在的架构节点：{item.get('node_id') or item.get('node') or item.get('name')}")
                continue
            if not requested or requested[-1] != node_id:
                requested.append(node_id)
            proposed[node_id] = {
                "label": str(item.get("label") or item.get("title") or "").strip()[:80],
                "explanation": str(item.get("explanation") or item.get("reason") or "").strip()[:500],
                "stage": str(item.get("stage") or "").strip()[:40],
            }
        if selected_node_id:
            if not requested or requested[0] != selected_node_id:
                requested.insert(0, selected_node_id)
        elif requested:
            selected_node_id = requested[0]
        if not requested:
            return [], warnings

        connected = [requested[0]]
        for target in requested[1:]:
            bridge = self._shortest_path(connected[-1], target, catalog["adjacency"])
            if not bridge:
                warnings.append(
                    f"架构图中不存在 {catalog['by_id'][connected[-1]]['name']} 到 {catalog['by_id'][target]['name']} 的连通路径"
                )
                continue
            if len(bridge) > 2:
                warnings.append("大模型路径跳过了架构中间节点，系统已按真实拓扑补全")
            connected.extend(bridge[1:])

        result: list[dict[str, str]] = []
        for index, node_id in enumerate(connected):
            node = catalog["by_id"][node_id]
            item = proposed.get(node_id, {})
            default_stage = "根因" if index == 0 else "受影响入口" if index == len(connected) - 1 else "故障传播"
            path_item = {
                "node_id": node_id,
                "node": node["name"],
                "label": item.get("label") or node["name"],
                "explanation": item.get("explanation") or "",
                "stage": item.get("stage") or default_stage,
            }
            target = self._node_target_summary(node)
            if target:
                path_item["target"] = target
            result.append(path_item)
        return result, list(dict.fromkeys(warnings))

    def _shortest_path(self, source: str, target: str, adjacency: dict[str, set[str]]) -> list[str]:
        if source == target:
            return [source]
        parents = {source: ""}
        queue = [source]
        for current in queue:
            for neighbor in sorted(adjacency.get(current, set())):
                if neighbor in parents:
                    continue
                parents[neighbor] = current
                if neighbor == target:
                    path = [target]
                    while parents[path[-1]]:
                        path.append(parents[path[-1]])
                    return list(reversed(path))
                queue.append(neighbor)
        return []

    def _compact_hypotheses(self, value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        allowed = (
            "rank",
            "candidate",
            "candidate_kind",
            "architecture_node",
            "fault_mode",
            "confidence",
            "status",
            "summary",
            "chain",
            "evidence",
            "missing_evidence",
            "validation_suggestions",
        )
        result: list[dict[str, Any]] = []
        for item in value[:8]:
            if not isinstance(item, dict):
                continue
            result.append({key: self._compact_value(item.get(key)) for key in allowed if key in item})
        return result

    def _compact_value(self, value: Any, depth: int = 0) -> Any:
        if depth >= 4:
            return "<truncated>"
        if value is None or isinstance(value, (bool, int, float)):
            return value
        if isinstance(value, str):
            text = value.strip()
            return text if len(text) <= 900 else text[:899] + "…"
        if isinstance(value, list):
            return [self._compact_value(item, depth + 1) for item in value[:12]]
        if isinstance(value, dict):
            items = list(value.items())[:24]
            return {str(key): self._compact_value(item, depth + 1) for key, item in items}
        return self._compact_value(str(value), depth + 1)

    def _safe_int(self, value: Any) -> int:
        try:
            return int(value)
        except Exception:
            return 0

    def _selected_hypothesis(
        self,
        hypotheses: list[Any],
        candidate: str,
        rank: int,
    ) -> dict[str, Any] | None:
        normalized_candidate = str(candidate or "").strip().casefold()
        if normalized_candidate:
            for item in hypotheses:
                if (
                    isinstance(item, dict)
                    and str(item.get("candidate") or "").strip().casefold() == normalized_candidate
                ):
                    return item
        if rank:
            for item in hypotheses:
                if isinstance(item, dict) and self._safe_int(item.get("rank")) == rank:
                    return item
        return None

    def _normalize_reason_items(self, value: Any) -> list[str]:
        if isinstance(value, list):
            raw_items = value
        else:
            text = str(value or "").strip()
            raw_items = re.split(r"(?:\r?\n|[；;])", text) if text else []
        items: list[str] = []
        for item in raw_items:
            text = str(item or "").strip()
            text = re.sub(r"^\s*(?:[-*•]|\d+[.)、])\s*", "", text).strip()
            if text and text not in items:
                items.append(text[:500])
        return items[:8]

    def _normalize_display_chain(
        self,
        value: Any,
        hypothesis: dict[str, Any] | None,
    ) -> list[dict[str, str]]:
        chain = hypothesis.get("chain") if isinstance(hypothesis, dict) else []
        node_names = [str(item).strip() for item in chain or [] if str(item).strip()]
        proposed: dict[str, dict[str, str]] = {}
        if isinstance(value, list):
            for item in value:
                if not isinstance(item, dict):
                    continue
                node = str(item.get("node") or item.get("name") or "").strip()
                if node and node in node_names:
                    proposed[node] = {
                        "label": str(item.get("label") or item.get("title") or node).strip()[:80],
                        "explanation": str(item.get("explanation") or item.get("reason") or "").strip()[:500],
                        "stage": str(item.get("stage") or "").strip()[:40],
                    }
        result: list[dict[str, str]] = []
        for index, node in enumerate(node_names):
            item = proposed.get(node, {})
            default_stage = "根因" if index == 0 else "受影响入口" if index == len(node_names) - 1 else "故障传播"
            result.append(
                {
                    "node": node,
                    "label": item.get("label") or node,
                    "explanation": item.get("explanation") or "",
                    "stage": item.get("stage") or default_stage,
                }
            )
        return result

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
