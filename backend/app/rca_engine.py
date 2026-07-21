from __future__ import annotations

import json
import re
from collections import deque
from dataclasses import asdict, dataclass, field
from typing import Any

from .models import GraphEdge, GraphNode, GraphResponse


# These edges point from a consumer/caller to the component it depends on.  A
# failure therefore propagates in the reverse direction of the stored edge.
DEPENDENCY_RELATIONS = {
    "CALLS",
    "DEPENDS_ON",
    "USES_DB",
    "READS",
    "WRITES",
    "PUBLISHES",
    "SUBSCRIBES",
    "CONNECTS_TO",
    "RUNS_ON",
}
MEMBERSHIP_RELATIONS = {"HAS_MEMBER", "CONTAINS"}
DYNAMIC_KINDS = {
    "Incident",
    "Trace",
    "LogEvent",
    "Exception",
    "Window",
    "Metric",
    "RCAHypothesis",
    "UnresolvedDependency",
}


def _compact(value: Any, limit: int = 420) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _norm(value: Any) -> str:
    text = str(value or "").lower().strip()
    text = re.sub(r"(?:service|server|svc|服务|应用|模块|系统)$", "", text)
    return re.sub(r"[^a-z0-9\u4e00-\u9fa5]", "", text)


def _listify(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return [str(item) for item in value if str(item).strip()]
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            decoded = json.loads(text)
            if isinstance(decoded, list):
                return [str(item) for item in decoded if str(item).strip()]
        except Exception:
            pass
        return [item.strip() for item in re.split(r"[,，;；]", text) if item.strip()]
    return [str(value)]


@dataclass(frozen=True)
class ArchitectureNode:
    name: str
    kind: str
    layer: str = ""
    description: str = ""
    meta: dict[str, Any] = field(default_factory=dict)

    def searchable_text(self) -> str:
        return " ".join(
            [self.name, self.kind, self.description, json.dumps(self.meta, ensure_ascii=False)]
        ).lower()

    def identifiers(self) -> set[str]:
        values: list[str] = [self.name]
        for key in (
            "alias",
            "aliases",
            "service",
            "service_name",
            "service_names",
            "instance",
            "instance_id",
            "host",
            "hostname",
            "ip",
            "endpoint",
            "endpoints",
        ):
            values.extend(_listify(self.meta.get(key)))
        hosts = _listify(self.meta.get("host") or self.meta.get("hostname") or self.meta.get("ip"))
        ports = _listify(self.meta.get("port") or self.meta.get("ports"))
        values.extend(f"{host}:{port}" for host in hosts for port in ports)
        return {str(value).lower().strip() for value in values if str(value).strip()}


@dataclass(frozen=True)
class ArchitectureEdge:
    source: str
    target: str
    relation: str
    description: str = ""


@dataclass(frozen=True)
class FaultSignal:
    fault_mode: str
    resource_tokens: tuple[str, ...]
    resource_kinds: tuple[str, ...]
    base_score: float
    description: str
    evidence: str
    timeout_only: bool = False


@dataclass
class RootCauseHypothesis:
    rank: int
    candidate: str
    candidate_kind: str
    fault_mode: str
    confidence: float
    status: str
    summary: str
    chain: list[str]
    path_steps: list[dict[str, str]]
    evidence: list[str]
    reasons: list[str]
    missing_evidence: list[str]
    validation_suggestions: list[dict[str, Any]] = field(default_factory=list)
    architecture_node: bool = True

    def model_dump(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RootCauseAnalysis:
    incident_id: str
    observed_root_service: str
    resolved_root_service: str
    signals: list[dict[str, Any]]
    hypotheses: list[RootCauseHypothesis]
    decision: str
    limitations: list[str]

    def model_dump(self) -> dict[str, Any]:
        data = asdict(self)
        data["hypotheses"] = [item.model_dump() for item in self.hypotheses]
        return data


class ArchitectureSnapshot:
    """Small in-memory projection used by the deterministic RCA search.

    HugeGraph remains the source of truth.  Pulling one bounded snapshot keeps
    the reasoning testable and avoids binding the algorithm to a Gremlin
    dialect/version.
    """

    def __init__(self, graph: GraphResponse | dict[str, Any]) -> None:
        raw_nodes = graph.nodes if isinstance(graph, GraphResponse) else graph.get("nodes", [])
        raw_edges = graph.edges if isinstance(graph, GraphResponse) else graph.get("edges", [])
        self.nodes: dict[str, ArchitectureNode] = {}
        for raw in raw_nodes:
            node = self._node(raw)
            if (
                node.name
                and node.kind not in DYNAMIC_KINDS
                and not bool((node.meta or {}).get("dynamic_observation"))
                and not (
                    "raw_service" in (node.meta or {})
                    and node.description == "异常链路关联到的服务"
                )
            ):
                self.nodes[node.name] = node
        self.edges: list[ArchitectureEdge] = []
        for raw in raw_edges:
            edge = self._edge(raw)
            if edge.source in self.nodes and edge.target in self.nodes:
                self.edges.append(edge)
        self.outgoing: dict[str, list[ArchitectureEdge]] = {}
        for edge in self.edges:
            self.outgoing.setdefault(edge.source, []).append(edge)

    @staticmethod
    def _node(raw: GraphNode | dict[str, Any]) -> ArchitectureNode:
        if isinstance(raw, GraphNode):
            return ArchitectureNode(raw.name, raw.kind, raw.layer, raw.description, raw.meta or {})
        return ArchitectureNode(
            str(raw.get("name") or raw.get("id") or ""),
            str(raw.get("kind") or "Component"),
            str(raw.get("layer") or ""),
            str(raw.get("description") or ""),
            raw.get("meta") if isinstance(raw.get("meta"), dict) else {},
        )

    @staticmethod
    def _edge(raw: GraphEdge | dict[str, Any]) -> ArchitectureEdge:
        if isinstance(raw, GraphEdge):
            return ArchitectureEdge(raw.source, raw.target, raw.type.upper(), raw.description)
        return ArchitectureEdge(
            str(raw.get("source") or ""),
            str(raw.get("target") or ""),
            str(raw.get("type") or raw.get("relation") or "CALLS").upper(),
            str(raw.get("description") or ""),
        )

    def resolve(self, value: str, kinds: set[str] | None = None) -> str:
        value = str(value or "").strip()
        if not value:
            return ""
        wanted = _norm(value)
        best_name = ""
        best_score = 0
        for node in self.nodes.values():
            if kinds and node.kind not in kinds:
                continue
            identifiers = node.identifiers()
            if value.lower() in identifiers:
                return node.name
            normalized = {_norm(item) for item in identifiers}
            if wanted and wanted in normalized:
                return node.name
            score = 0
            if wanted and any(wanted in item or item in wanted for item in normalized if item):
                score = min(len(wanted), 20)
            if score > best_score:
                best_name, best_score = node.name, score
        return best_name

    def paths_from(self, start: str, max_depth: int = 5) -> dict[str, tuple[list[str], list[str]]]:
        """Return consumer->dependency paths, including cluster membership."""
        if start not in self.nodes:
            return {}
        found: dict[str, tuple[list[str], list[str]]] = {start: ([start], [])}
        queue: deque[tuple[str, list[str], list[str]]] = deque([(start, [start], [])])
        while queue:
            current, names, relations = queue.popleft()
            if len(relations) >= max_depth:
                continue
            for edge in self.outgoing.get(current, []):
                if not self._traversable(edge):
                    continue
                if edge.target in names:
                    continue
                new_names = [*names, edge.target]
                new_relations = [*relations, edge.relation]
                old = found.get(edge.target)
                if old is None or len(new_relations) < len(old[1]):
                    found[edge.target] = (new_names, new_relations)
                    queue.append((edge.target, new_names, new_relations))
        return found

    def find_dependency_path(self, start: str, target: str, max_depth: int = 5) -> tuple[list[str], list[str]] | None:
        return self.paths_from(start, max_depth=max_depth).get(target)

    def _traversable(self, edge: ArchitectureEdge) -> bool:
        if edge.relation in DEPENDENCY_RELATIONS or edge.relation == "HAS_MEMBER":
            return True
        if edge.relation != "CONTAINS":
            return False
        source = self.nodes.get(edge.source)
        target = self.nodes.get(edge.target)
        return bool(
            source
            and target
            and source.kind in {"Cluster", "Cache", "Database", "Middleware", "Queue", "Component"}
            and target.kind not in {"System", "Layer", "Function", "API"}
        )

    def member_count(self, name: str) -> int:
        return sum(
            1
            for edge in self.outgoing.get(name, [])
            if edge.relation in MEMBERSHIP_RELATIONS and edge.target in self.nodes
        )


class RootCauseEngine:
    """Rank evidence-backed root-cause hypotheses over architecture topology.

    The score is deliberately heuristic, not a statistical probability.  It
    combines a fault signature, entity/endpoint match and graph distance.  The
    local LLM can explain the resulting JSON, but it is not allowed to invent a
    topology path or promote an unobserved Redis member to a confirmed failure.
    """

    SERVICE_KINDS = {"Service", "API", "Component", "Pod"}

    def __init__(self, graph: GraphResponse | dict[str, Any]) -> None:
        self.graph = ArchitectureSnapshot(graph)

    def analyze(self, detail: dict[str, Any], top_k: int = 5) -> RootCauseAnalysis:
        incident_id = str(detail.get("incident_id") or "I00000")
        raw_service = str(detail.get("root_service_candidate") or "")
        anchor = self.graph.resolve(raw_service, self.SERVICE_KINDS)
        signals = self._signals(detail)
        endpoints = self._endpoint_tokens(detail)
        candidates: list[dict[str, Any]] = []

        dependency_paths = self.graph.paths_from(anchor) if anchor else {}
        for signal in signals:
            for node in self.graph.nodes.values():
                path = dependency_paths.get(node.name)
                direct_endpoint = self._endpoint_matches(node, endpoints)
                match = self._resource_match(node, path, signal)
                if not direct_endpoint and match <= 0:
                    continue
                # A service is only a resource candidate when its own name/meta
                # matches the resource signature; otherwise CALLS would make
                # every downstream service look like a Redis/MySQL candidate.
                if node.kind in self.SERVICE_KINDS and match < 2 and not direct_endpoint:
                    continue
                depth = len(path[1]) if path else 99
                score = signal.base_score
                reasons = [f"故障特征匹配：{signal.description}"]
                if match >= 2:
                    score += 0.16
                    reasons.append("节点名称/别名/描述与依赖类型直接匹配")
                elif match == 1:
                    score += 0.04
                    reasons.append("节点类型与所在依赖路径匹配")
                if node.kind in signal.resource_kinds:
                    score += 0.08
                if path:
                    topology_score = max(0.05, 0.18 - max(depth - 1, 0) * 0.025)
                    score += topology_score
                    reasons.append(f"从 {anchor} 沿依赖边 {depth} 跳可达")
                if direct_endpoint:
                    score += 0.27
                    reasons.append(f"日志目标 {direct_endpoint} 与节点标识直接匹配")
                if node.kind == "Cluster":
                    score += 0.03
                if node.kind in {"Instance", "Host", "Pod"} and not direct_endpoint:
                    score -= 0.20
                    reasons.append("缺少指向该具体实例的日志或健康检查，实例级候选降权")
                candidates.append(
                    {
                        "node": node,
                        "signal": signal,
                        "path": path,
                        "score": max(0.05, min(score, 0.98)),
                        "reasons": reasons,
                        "direct_endpoint": direct_endpoint,
                    }
                )

        candidates = self._dedupe_candidates(candidates)
        if not candidates:
            candidates.append(self._fallback_candidate(anchor, raw_service, signals, detail))

        candidates.sort(key=lambda item: (-item["score"], item["node"].name))
        hypotheses: list[RootCauseHypothesis] = []
        for rank, item in enumerate(candidates[: max(1, top_k)], start=1):
            hypotheses.append(self._hypothesis(rank, item, anchor, detail, endpoints))

        top = hypotheses[0] if hypotheses else None
        limitations = ["confidence 是可解释启发式评分，不是统计概率。"]
        if top and top.missing_evidence:
            limitations.extend(top.missing_evidence)
        if top:
            decision = (
                f"当前首选根因假设：{top.candidate} / {top.fault_mode}，"
                f"评分 {top.confidence:.2f}；链路：{' -> '.join(top.chain)}。"
            )
        else:
            decision = "没有形成可用根因假设，请补充架构依赖和结构化错误证据。"
        return RootCauseAnalysis(
            incident_id=incident_id,
            observed_root_service=raw_service,
            resolved_root_service=anchor,
            signals=[asdict(signal) for signal in signals],
            hypotheses=hypotheses,
            decision=decision,
            limitations=list(dict.fromkeys(limitations)),
        )

    def _signals(self, detail: dict[str, Any]) -> list[FaultSignal]:
        evidence_parts = [
            detail.get("root_cause_candidate"),
            detail.get("root_evidence"),
        ]
        for item in detail.get("root_candidates") or []:
            if isinstance(item, dict):
                evidence_parts.extend(
                    [item.get("root_exception_class"), item.get("root_cause"), item.get("message"), item.get("logger")]
                )
        for item in detail.get("timeline") or []:
            if isinstance(item, dict) and str(item.get("level") or "").upper() in {"WARN", "ERROR"}:
                evidence_parts.extend([item.get("root_cause"), item.get("message"), item.get("logger")])
        evidence = _compact(" | ".join(str(item) for item in evidence_parts if item), 900)
        text = evidence.lower()
        signals: list[FaultSignal] = []

        if any(token in text for token in ("redis", "lettuce", "jedis")):
            if any(token in text for token in ("connection refused", "redisconnectionexception", "cannot connect", "connection reset")):
                signals.append(
                    FaultSignal(
                        "REDIS_UNREACHABLE",
                        ("redis", "lettuce", "jedis"),
                        ("Cache", "Cluster", "Instance", "Host", "Database", "Middleware"),
                        0.46,
                        "Redis 连接不可达/被拒绝",
                        evidence,
                    )
                )
            elif any(token in text for token in ("timeout", "timed out", "querytimeoutexception")):
                signals.append(
                    FaultSignal(
                        "REDIS_TIMEOUT",
                        ("redis", "lettuce", "jedis"),
                        ("Cache", "Cluster", "Instance", "Host", "Database", "Middleware"),
                        0.30,
                        "Redis 命令执行超时",
                        evidence,
                        timeout_only=True,
                    )
                )

        if any(token in text for token in ("mysql", "jdbc", "hikari", "sql")):
            mode = "DATABASE_UNREACHABLE" if "connection refused" in text else "DATABASE_FAILURE"
            signals.append(
                FaultSignal(
                    mode,
                    ("mysql", "database", "数据库", "jdbc", "hikari"),
                    ("Database", "Cluster", "Instance", "Host"),
                    0.38,
                    "数据库连接或查询失败",
                    evidence,
                    timeout_only="timeout" in text or "timed out" in text,
                )
            )

        if any(token in text for token in ("kafka", "rabbitmq", "rocketmq")):
            signals.append(
                FaultSignal(
                    "MESSAGE_BROKER_FAILURE",
                    ("kafka", "rabbitmq", "rocketmq", "mq"),
                    ("Queue", "Cluster", "Instance", "Host", "Middleware"),
                    0.38,
                    "消息中间件连接或处理失败",
                    evidence,
                    timeout_only="timeout" in text or "timed out" in text,
                )
            )

        if not signals and any(token in text for token in ("timeout", "timed out", "connection refused", "connection reset")):
            signals.append(
                FaultSignal(
                    "DEPENDENCY_FAILURE",
                    (),
                    ("Database", "Cache", "Queue", "Middleware", "Cluster", "Instance", "Host", "Service"),
                    0.22,
                    "通用依赖连接/超时故障",
                    evidence,
                    timeout_only="timeout" in text or "timed out" in text,
                )
            )
        if not signals:
            signals.append(
                FaultSignal(
                    "APPLICATION_ERROR",
                    (),
                    ("Service", "API", "Component"),
                    0.18,
                    "应用异常，尚未识别到特定依赖类型",
                    evidence or _compact(detail.get("root_cause_candidate")),
                )
            )
        return signals

    def _resource_match(
        self,
        node: ArchitectureNode,
        path: tuple[list[str], list[str]] | None,
        signal: FaultSignal,
    ) -> int:
        own = node.searchable_text()
        if not signal.resource_tokens:
            return 1 if node.kind in signal.resource_kinds and path else 0
        own_hit = any(token.lower() in own for token in signal.resource_tokens)
        context = ""
        if path:
            context = " ".join(self.graph.nodes[name].searchable_text() for name in path[0] if name in self.graph.nodes)
        context_hit = any(token.lower() in context for token in signal.resource_tokens)
        if own_hit:
            return 2
        if node.kind in signal.resource_kinds and context_hit:
            return 1
        return 0

    def _endpoint_tokens(self, detail: dict[str, Any]) -> set[str]:
        text = " ".join(
            str(value or "")
            for value in [
                detail.get("root_cause_candidate"),
                detail.get("root_evidence"),
                json.dumps(detail.get("root_candidates") or [], ensure_ascii=False),
                json.dumps(detail.get("timeline") or [], ensure_ascii=False),
            ]
        )
        tokens: set[str] = set()
        tokens.update(match.lower() for match in re.findall(r"\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b", text))
        tokens.update(
            match.lower()
            for match in re.findall(r"\b[a-zA-Z][a-zA-Z0-9_.-]{1,80}:\d{2,5}\b", text)
            if not re.fullmatch(r"(?:http|https):\d+", match.lower())
        )
        for match in re.finditer(
            r"(?i)\b(?:host|hostname|node|instance|endpoint|server|redis)\s*[=:]\s*([a-z0-9_.-]+(?::\d{2,5})?)",
            text,
        ):
            tokens.add(match.group(1).lower())
        return tokens

    def _endpoint_matches(self, node: ArchitectureNode, endpoints: set[str]) -> str:
        if not endpoints:
            return ""
        identifiers = node.identifiers()
        for endpoint in endpoints:
            host = endpoint.split(":", 1)[0]
            for identifier in identifiers:
                ident_host = identifier.split(":", 1)[0]
                if endpoint == identifier:
                    return endpoint
                # When the log names a port, require the complete endpoint.
                # Host-only matching would confuse two Redis processes running
                # on the same machine with different ports.
                if ":" not in endpoint and host and host == ident_host:
                    return endpoint
        return ""

    def _dedupe_candidates(self, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
        best: dict[str, dict[str, Any]] = {}
        counts: dict[str, int] = {}
        for item in candidates:
            name = item["node"].name
            counts[name] = counts.get(name, 0) + 1
            if name not in best or item["score"] > best[name]["score"]:
                best[name] = item
        for name, item in best.items():
            corroboration = min(max(counts[name] - 1, 0) * 0.03, 0.09)
            if corroboration:
                item["score"] = min(item["score"] + corroboration, 0.98)
                item["reasons"].append(f"{counts[name]} 类独立故障特征共同指向该节点")
        return list(best.values())

    def _fallback_candidate(
        self,
        anchor: str,
        raw_service: str,
        signals: list[FaultSignal],
        detail: dict[str, Any],
    ) -> dict[str, Any]:
        if anchor and anchor in self.graph.nodes:
            node = self.graph.nodes[anchor]
            architecture_node = True
        else:
            name = raw_service or "未解析的故障组件"
            node = ArchitectureNode(name=name, kind="UnresolvedDependency")
            architecture_node = False
        signal = signals[0]
        return {
            "node": node,
            "signal": signal,
            "path": ([anchor], []) if anchor else None,
            "score": min(signal.base_score + 0.12, 0.45),
            "reasons": ["图谱中没有找到与故障特征匹配的依赖节点，暂时保留日志侧候选"],
            "direct_endpoint": "",
            "architecture_node": architecture_node,
            "fallback": True,
            "detail": detail,
        }

    def _hypothesis(
        self,
        rank: int,
        item: dict[str, Any],
        anchor: str,
        detail: dict[str, Any],
        endpoints: set[str],
    ) -> RootCauseHypothesis:
        node: ArchitectureNode = item["node"]
        signal: FaultSignal = item["signal"]
        path = item.get("path")
        chain, steps = self._causal_path(path)
        if not chain:
            chain = [node.name]
        extension_names, extension_steps = self._upstream_extension(anchor, detail)
        if extension_names and chain[-1] == extension_names[0]:
            chain.extend(extension_names[1:])
            steps.extend(extension_steps)

        missing: list[str] = []
        if not path and node.name != anchor:
            missing.append("候选节点与故障服务之间缺少可遍历的架构依赖边。")
        members = self.graph.member_count(node.name)
        if signal.timeout_only:
            missing.append("超时也可能由慢请求、网络拥塞、连接池耗尽或资源过载造成，不能仅凭超时断言节点宕机。")
        if members and not endpoints:
            missing.append(f"{node.name} 在图谱中有 {members} 个成员，但日志没有目标 host/IP/port 或节点健康状态，无法确认具体成员。")
        if node.kind in {"Instance", "Host", "Pod"} and not item.get("direct_endpoint"):
            missing.append("缺少与该实例直接匹配的 host/IP/port、探针或 Redis 节点日志。")
        if item.get("fallback"):
            missing.append("请在架构图中补充服务到 Redis/数据库/中间件的 DEPENDS_ON 边及实例拓扑。")

        score = round(float(item["score"]), 3)
        status = "probable" if score >= 0.75 else "suspected" if score >= 0.50 else "weak"
        summary = f"{node.name} 可能发生{signal.description}"
        if len(chain) > 1:
            summary += f"，故障可能沿 {' -> '.join(chain)} 传播"
        evidence = [signal.evidence] if signal.evidence else []
        if item.get("direct_endpoint"):
            evidence.append(f"直接目标标识：{item['direct_endpoint']}")
        validation_suggestions = self._validation_suggestions(
            node=node,
            signal=signal,
            chain=chain,
            missing_evidence=missing,
            direct_endpoint=str(item.get("direct_endpoint") or ""),
        )
        return RootCauseHypothesis(
            rank=rank,
            candidate=node.name,
            candidate_kind=node.kind,
            fault_mode=signal.fault_mode,
            confidence=score,
            status=status,
            summary=summary,
            chain=chain,
            path_steps=steps,
            evidence=list(dict.fromkeys(filter(None, evidence))),
            reasons=list(dict.fromkeys(item["reasons"])),
            missing_evidence=list(dict.fromkeys(missing)),
            validation_suggestions=validation_suggestions,
            architecture_node=bool(item.get("architecture_node", True)),
        )

    def _validation_suggestions(
        self,
        *,
        node: ArchitectureNode,
        signal: FaultSignal,
        chain: list[str],
        missing_evidence: list[str],
        direct_endpoint: str,
    ) -> list[dict[str, Any]]:
        """Return manual validation runbook steps for the current hypothesis.

        These are deliberately suggestions, not executable probes.  The system
        has not been granted credentials for Redis, databases, Kubernetes or
        metrics backends, so every step is labelled as manual.
        """
        suggestions: list[dict[str, Any]] = []

        def add(
            check_id: str,
            title: str,
            priority: str,
            evidence_type: str,
            reason: str,
            manual_command_hint: str = "",
        ) -> None:
            suggestions.append(
                {
                    "check_id": check_id,
                    "title": title,
                    "priority": priority,
                    "target": node.name,
                    "target_kind": node.kind,
                    "fault_mode": signal.fault_mode,
                    "evidence_type": evidence_type,
                    "execution_mode": "manual",
                    "reason": reason,
                    "manual_command_hint": manual_command_hint,
                    "chain_context": chain,
                }
            )

        if signal.fault_mode == "REDIS_TIMEOUT":
            add(
                "redis_latency",
                "确认 Redis 是否存在高延迟或慢命令",
                "high",
                "redis_health",
                "当前日志能证明 Redis 依赖超时，但不能区分 Redis 慢、网络慢或客户端连接池耗尽。",
                "redis-cli --latency；redis-cli SLOWLOG GET 20；检查 Redis INFO commandstats/latencystats",
            )
            add(
                "client_pool_exhaustion",
                "检查调用方 Redis 连接池和线程池是否耗尽",
                "high",
                "client_runtime",
                "超时可能发生在调用方排队、连接池不足或线程池阻塞阶段。",
                "检查应用 Hikari/Lettuce/Jedis pool 指标、线程池队列、GC pause 和超时配置",
            )
            add(
                "network_path_latency",
                "检查服务到 Redis 的网络延迟和丢包",
                "medium",
                "network",
                "拓扑链路显示故障可能沿依赖路径传播，需要确认链路本身是否异常。",
                "从调用方节点执行 ping/mtr/tcping 到 Redis endpoint，并核对同时间段网络监控",
            )
        elif signal.fault_mode == "REDIS_UNREACHABLE":
            add(
                "redis_endpoint_reachability",
                "确认目标 Redis endpoint 是否可连接",
                "high",
                "endpoint_reachability",
                "日志包含连接不可达/拒绝信号，应优先验证目标实例或集群入口是否仍在监听。",
                f"redis-cli -h <host> -p <port> PING；nc -vz <host> <port>{f'；日志命中 {direct_endpoint}' if direct_endpoint else ''}",
            )
            add(
                "redis_cluster_state",
                "检查 Redis Sentinel/Cluster 和实例进程状态",
                "high",
                "redis_health",
                "连接被拒绝可能来自实例宕机、主从切换、槽位迁移或服务端口未监听。",
                "redis-cli CLUSTER INFO；redis-cli SENTINEL masters；systemctl/docker/kubectl 查看实例状态",
            )
        elif signal.fault_mode in {"DATABASE_FAILURE", "DATABASE_UNREACHABLE"}:
            add(
                "database_connectivity",
                "确认数据库 endpoint、连接数和慢查询状态",
                "high",
                "database_health",
                "数据库类异常需要区分不可达、连接池耗尽、锁等待和慢查询。",
                "检查 DB 连接数、slow query、lock wait、主从延迟和应用连接池指标",
            )
        elif signal.fault_mode == "MESSAGE_BROKER_FAILURE":
            add(
                "broker_health",
                "确认消息中间件 broker、分区和消费积压状态",
                "high",
                "broker_health",
                "消息中间件异常需要核查 broker 可用性、队列积压和客户端连接状态。",
                "检查 Kafka/RabbitMQ/RocketMQ broker 状态、consumer lag、连接数和错误日志",
            )
        elif signal.fault_mode == "DEPENDENCY_FAILURE":
            add(
                "dependency_reachability",
                "确认下游依赖的健康状态和网络连通性",
                "high",
                "dependency_health",
                "日志只暴露通用超时/连接异常，需要沿图谱链路逐跳确认依赖是否可用。",
                "按 RCA 链路从调用方到候选依赖逐跳执行健康检查、端口连通性和错误日志核对",
            )
        else:
            add(
                "application_error_context",
                "补充应用异常上下文和近期变更信息",
                "medium",
                "application_context",
                "当前异常尚未识别为明确的基础设施依赖故障，需要先确认代码、配置或发布变更。",
                "核对同时间段发布记录、配置变更、应用 ERROR 日志、线程栈和业务错误码",
            )

        if not direct_endpoint and (
            node.kind in {"Cluster", "Cache", "Database", "Middleware", "Queue"}
            or any("host/IP/port" in item for item in missing_evidence)
        ):
            add(
                "endpoint_identity",
                "补充候选组件的具体 host/IP/port 或实例健康证据",
                "high",
                "endpoint_identity",
                "当前候选还停留在组件/集群级，缺少能确认具体实例的直接标识。",
                "在架构图 meta 中补充 host/ip/port/endpoints，并核对日志是否出现目标 endpoint",
            )

        if chain and len(chain) > 1:
            add(
                "propagation_chain_check",
                "沿 RCA 链路核对上游是否为传播影响",
                "medium",
                "topology_propagation",
                "需要确认链路上游错误是由候选根因传播导致，而不是独立故障。",
                "按链路顺序核对 trace、时间线、调用错误码和上游服务健康状态",
            )

        deduped: dict[str, dict[str, Any]] = {}
        for suggestion in suggestions:
            deduped.setdefault(str(suggestion["check_id"]), suggestion)
        return list(deduped.values())

    def _causal_path(self, path: tuple[list[str], list[str]] | None) -> tuple[list[str], list[dict[str, str]]]:
        if not path:
            return [], []
        names, relations = path
        causal_names = list(reversed(names))
        steps: list[dict[str, str]] = []
        for index in range(len(names) - 1, 0, -1):
            stored_relation = relations[index - 1]
            steps.append(
                {
                    "source": names[index],
                    "target": names[index - 1],
                    "relation": "FAULT_PROPAGATES_TO",
                    "basis": f"reverse_of:{stored_relation}",
                }
            )
        return causal_names, steps

    def _upstream_extension(self, anchor: str, detail: dict[str, Any]) -> tuple[list[str], list[dict[str, str]]]:
        if not anchor:
            return [], []
        raw_candidates: list[str] = []
        for effect in detail.get("upstream_effects") or []:
            if isinstance(effect, dict):
                raw_candidates.append(str(effect.get("service") or ""))
        for event in detail.get("timeline") or []:
            if isinstance(event, dict) and str(event.get("level") or "").upper() == "ERROR":
                raw_candidates.append(str(event.get("service") or ""))

        for raw in raw_candidates:
            other = self.graph.resolve(raw, self.SERVICE_KINDS)
            if not other or other == anchor:
                continue
            # Stored direction is upstream caller -> downstream dependency.
            path = self.graph.find_dependency_path(other, anchor, max_depth=4)
            if path:
                names, steps = self._causal_path(path)
                if names and names[0] == anchor:
                    return names, steps
            # upstream_effects is produced from a later same-trace ERROR.  It is
            # weaker than topology, but still useful and is labelled explicitly.
            if any(str(effect.get("service") or "") == raw for effect in detail.get("upstream_effects") or [] if isinstance(effect, dict)):
                return [anchor, other], [
                    {
                        "source": anchor,
                        "target": other,
                        "relation": "ERROR_PROPAGATES_TO",
                        "basis": "same_trace_later_upstream_error",
                    }
                ]
        return [], []


def hypotheses_from_persisted_graph(graph: GraphResponse, incident_id: str) -> list[dict[str, Any]]:
    """Read hypothesis metadata back from the generic HugeGraph read model."""
    incident_name = incident_id if incident_id.startswith("Incident:") else f"Incident:{incident_id}"
    hypothesis_names = {
        edge.target
        for edge in graph.edges
        if edge.source == incident_name and edge.type == "HAS_HYPOTHESIS"
    }
    results = [
        {"name": node.name, **(node.meta or {})}
        for node in graph.nodes
        if node.name in hypothesis_names and node.kind == "RCAHypothesis"
    ]
    return sorted(results, key=lambda item: int(item.get("rank") or 9999))
