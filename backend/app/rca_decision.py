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
from .log_compression import LogCompressionConfig, LogContextCompressor


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
        fallback = self._fallback_decision(analysis, source="fallback")
        if not bool(getattr(self.settings, "rca_decision_enabled", True)):
            return {**fallback, "error": "RCA decision model is disabled"}

        compression_summary: dict[str, Any] = {}
        try:
            prompt, compression_summary = self._build_prompt_with_meta(detail, analysis, architecture)
            raw_content, meta = self._post_conversation(prompt)
            parsed = self._parse_model_json(raw_content)
            result = self._normalize_model_result(parsed, analysis, fallback, architecture)
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
        path, path_warnings = self._normalize_architecture_path(
            parsed.get("propagation_path") or parsed.get("display_chain"),
            selected_node_id,
            catalog,
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
        return {
            "selected_candidate": selected,
            "selected_node_id": selected_node_id,
            "selected_candidate_rank": rank,
            "selected_fault_mode": fault_mode,
            "most_likely_reason": "；".join(reason_items) or reason,
            "most_likely_reasons": reason_items,
            "troubleshooting_methods": steps,
            "propagation_path": display_chain,
            "display_chain": display_chain,
            "confidence": parsed.get("confidence", fallback.get("confidence")),
            "notes": self._normalize_steps(parsed.get("notes")),
            "path_validation_warnings": path_warnings,
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

        prompt_data = {
            "architecture_graph": self._architecture_prompt_data(architecture),
            "incident": {
                "incident_id": detail.get("incident_id") or analysis.get("incident_id"),
                "root_service_candidate": detail.get("root_service_candidate"),
                "root_cause_candidate": detail.get("root_cause_candidate"),
                "root_evidence": self._compact_value(detail.get("root_evidence")),
                "candidate_reason_logs": self._compact_value(detail.get("root_candidates") or []),
                "upstream_effect_logs": self._compact_value(detail.get("upstream_effects") or []),
                "fault_start": detail.get("fault_start"),
                "fault_end": detail.get("fault_end"),
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
            "你是生产故障 RCA 决策助手。architecture_graph 是本项目系统架构的唯一实体和关系来源。"
            "请结合候选原因日志、完整架构节点及边，判断根因并组织传播路径。不要编造节点、节点 ID、关系或日志证据。\n"
            "incident.log_context 已经过确定性日志压缩：key_events 是按严重度、异常信号、稀有度、"
            "服务/trace 多样性和故障邻域筛选的关键事件；repeated_patterns 汇总被折叠的重复日志。\n"
            "决策约束（按优先级）：\n"
            "1. selected_node_id 必须来自 architecture_graph.nodes[].node_id；节点显示名称只能取对应 name。\n"
            "2. propagation_path 按‘根因 → 故障传播节点 → 受影响入口’排序，每个 node_id 必须真实存在。\n"
            "3. 路径中相邻节点必须由 architecture_graph.edges 中的边直接连接；边方向表示系统依赖，传播方向可与依赖方向相反。\n"
            "4. algorithm_candidates 只是辅助证据，可以纠正其候选名称和链路，但结论必须落在架构节点上。\n"
            "5. 根因依据、排查步骤、selected_node_id 和 propagation_path 必须指向同一个根因，不得互相矛盾。\n"
            "请严格返回 JSON 对象，不要 Markdown，不要解释，不要代码块。JSON 格式：\n"
            "{"
            '"selected_node_id":"architecture_graph 中真实 node_id",'
            '"selected_candidate":"该 node_id 对应的真实 name",'
            '"selected_candidate_rank":1,'
            '"selected_fault_mode":"故障模式",'
            '"most_likely_reasons":["根因依据1","根因依据2","根因依据3"],'
            '"troubleshooting_methods":["排查步骤1","排查步骤2"],'
            '"propagation_path":[{"node_id":"真实 node_id","label":"面向用户的简短名称","stage":"根因/故障传播/受影响入口","explanation":"该节点在传播链中的作用"}],'
            '"confidence":0.0,'
            '"notes":["需要补充的证据或注意点"]'
            "}\n"
            "propagation_path 的第一个节点必须等于 selected_node_id；label 和 explanation 应使用业务人员容易理解的中文，"
            "并与根因依据和排查步骤保持一致。若架构图中不存在日志提到的组件，不得编造该组件；请在 notes 中说明缺失。\n"
            f"输入数据：\n{json.dumps(prompt_data, ensure_ascii=False, indent=2)}"
        )
        return prompt, dict(log_context.get("summary") or {})

    def _architecture_prompt_data(self, architecture: Any | None) -> dict[str, Any]:
        catalog = self._architecture_catalog(architecture)
        return {
            "nodes": list(catalog["nodes"]),
            "edges": list(catalog["edges"]),
        }

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
            aliases: list[str] = []
            for key in ("aliases", "alias", "service_name", "serviceName", "application_name"):
                value = meta.get(key)
                values = value if isinstance(value, list) else [value]
                aliases.extend(str(item).strip() for item in values if str(item or "").strip())
            aliases = list(dict.fromkeys(aliases))
            node = {
                "node_id": node_id,
                "name": name,
                "aliases": aliases,
                "kind": str(data.get("kind") or "Component"),
                "layer": str(data.get("layer") or ""),
                "description": str(data.get("description") or "")[:500],
            }
            nodes.append(node)
            by_id[node_id] = node
            name_to_id[name] = node_id
            for identifier in [node_id, name, *aliases]:
                alias_to_id.setdefault(str(identifier).strip().casefold(), node_id)

        edges: list[dict[str, str]] = []
        adjacency: dict[str, set[str]] = {node_id: set() for node_id in by_id}
        for raw in raw_edges or []:
            data = raw if isinstance(raw, dict) else getattr(raw, "model_dump", lambda: {})()
            source = name_to_id.get(str(data.get("source") or ""), str(data.get("source") or ""))
            target = name_to_id.get(str(data.get("target") or ""), str(data.get("target") or ""))
            if source not in by_id or target not in by_id or source == target:
                continue
            edges.append({
                "source_node_id": source,
                "target_node_id": target,
                "type": str(data.get("type") or "CALLS"),
                "description": str(data.get("description") or "")[:300],
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
            result.append({
                "node_id": node_id,
                "node": node["name"],
                "label": item.get("label") or node["name"],
                "explanation": item.get("explanation") or "",
                "stage": item.get("stage") or default_stage,
            })
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
