from __future__ import annotations

from pathlib import Path

from app.analyzer import RuleBasedArchitectureExtractor
from app.log_integration import IncidentGraphIntegrator, LogFaultRunner
from app.models import GraphEdge, GraphNode, GraphResponse
from app.rca_engine import RootCauseEngine, hypotheses_from_persisted_graph


def architecture_graph() -> GraphResponse:
    nodes = [
        GraphNode(id="api-gateway", name="api-gateway", kind="API", layer="网关层", meta={"aliases": ["gateway"]}),
        GraphNode(id="security-service", name="security-service", kind="Service", layer="业务服务层", meta={"aliases": ["security"]}),
        GraphNode(id="redis-prod", name="Redis生产集群", kind="Cluster", layer="基础设施层", meta={"aliases": ["redis-prod"]}),
        GraphNode(id="redis-1", name="redis-1", kind="Instance", layer="基础设施层", meta={"host": "redis-1", "port": 6379}),
        GraphNode(id="redis-2", name="redis-2", kind="Instance", layer="基础设施层", meta={"host": "redis-2", "port": 6379}),
        GraphNode(id="redis-3", name="redis-3", kind="Instance", layer="基础设施层", meta={"host": "redis-3", "port": 6379}),
    ]
    edges = [
        GraphEdge(source="api-gateway", target="security-service", type="CALLS"),
        GraphEdge(source="security-service", target="Redis生产集群", type="DEPENDS_ON"),
        GraphEdge(source="Redis生产集群", target="redis-1", type="HAS_MEMBER"),
        GraphEdge(source="Redis生产集群", target="redis-2", type="HAS_MEMBER"),
        GraphEdge(source="Redis生产集群", target="redis-3", type="HAS_MEMBER"),
    ]
    return GraphResponse(nodes=nodes, edges=edges)


def redis_timeout_detail() -> dict:
    return {
        "incident_id": "I00001",
        "primary_trace_id": "546d9959",
        "root_service_candidate": "security-service",
        "root_cause_candidate": "io.lettuce.core.RedisCommandTimeoutException: Command timed out after 20 seconds",
        "root_evidence": "Caused by: io.lettuce.core.RedisCommandTimeoutException: Command timed out after 20 seconds",
        "root_candidates": [
            {
                "service": "security-service",
                "root_exception_class": "io.lettuce.core.RedisCommandTimeoutException",
                "root_cause": "Command timed out after 20 seconds",
                "level": "ERROR",
            }
        ],
        "timeline": [
            {"timestamp": "2026-01-20 14:12:21.240", "level": "ERROR", "service": "security-service"},
            {"timestamp": "2026-01-20 14:12:21.255", "level": "ERROR", "service": "api-gateway"},
        ],
        "upstream_effects": [
            {"timestamp": "2026-01-20 14:12:21.255", "service": "api-gateway", "message": "502 Bad Gateway"}
        ],
    }


def test_timeout_stops_at_cluster_without_instance_evidence() -> None:
    result = RootCauseEngine(architecture_graph()).analyze(redis_timeout_detail())

    top = result.hypotheses[0]
    assert top.candidate == "Redis生产集群"
    assert top.fault_mode == "REDIS_TIMEOUT"
    assert top.chain == ["Redis生产集群", "security-service", "api-gateway"]
    assert top.status == "probable"
    assert any("无法确认具体成员" in item for item in top.missing_evidence)
    assert any("不能仅凭超时断言节点宕机" in item for item in top.missing_evidence)


def test_host_and_port_evidence_promotes_specific_redis_member() -> None:
    detail = redis_timeout_detail()
    detail["root_cause_candidate"] = (
        "io.lettuce.core.RedisConnectionException: Unable to connect to redis-2:6379; connection refused"
    )
    detail["root_evidence"] = "node=redis-2:6379 connection refused"

    result = RootCauseEngine(architecture_graph()).analyze(detail)
    top = result.hypotheses[0]

    assert top.candidate == "redis-2"
    assert top.fault_mode == "REDIS_UNREACHABLE"
    assert top.confidence >= 0.9
    assert top.chain == ["redis-2", "Redis生产集群", "security-service", "api-gateway"]
    assert any("redis-2:6379" in item for item in top.evidence)


def test_persisted_hypotheses_are_read_in_rank_order() -> None:
    graph = architecture_graph()
    graph.nodes.extend(
        [
            GraphNode(id="h2", name="RCAHypothesis:I00001:02", kind="RCAHypothesis", meta={"rank": 2, "candidate": "redis-2"}),
            GraphNode(id="h1", name="RCAHypothesis:I00001:01", kind="RCAHypothesis", meta={"rank": 1, "candidate": "Redis生产集群"}),
            GraphNode(id="incident", name="Incident:I00001", kind="Incident"),
        ]
    )
    graph.edges.extend(
        [
            GraphEdge(source="Incident:I00001", target="RCAHypothesis:I00001:02", type="HAS_HYPOTHESIS"),
            GraphEdge(source="Incident:I00001", target="RCAHypothesis:I00001:01", type="HAS_HYPOTHESIS"),
        ]
    )

    persisted = hypotheses_from_persisted_graph(graph, "I00001")
    assert [item["rank"] for item in persisted] == [1, 2]


class FakeGraphDb:
    def __init__(self, graph: GraphResponse) -> None:
        self.graph = graph
        self.upserts: list[dict] = []
        self.edges: list[tuple[str, str, str]] = []

    def ensure_schema(self) -> list[str]:
        return []

    def read_graph(self, limit: int = 5000) -> GraphResponse:
        return self.graph

    def upsert_node(self, **kwargs):
        self.upserts.append(kwargs)
        return {"id": kwargs["name"]}

    def add_edge_by_names(self, source: str, target: str, relation_type: str, description: str, meta: dict):
        self.edges.append((source, target, relation_type))
        return {"id": f"{source}|{relation_type}|{target}"}


def test_incident_import_does_not_overwrite_curated_architecture_nodes() -> None:
    db = FakeGraphDb(architecture_graph())
    integrator = IncidentGraphIntegrator(db=db)  # type: ignore[arg-type]
    integrator._import_details([redis_timeout_detail()], "test.json")

    updated_names = {item["name"] for item in db.upserts}
    assert "security-service" not in updated_names
    assert "api-gateway" not in updated_names
    assert "Redis生产集群" not in updated_names
    assert "RCAHypothesis:I00001:01" in updated_names
    assert ("Incident:I00001", "Redis生产集群", "SUSPECTED_ROOT_CAUSE") in db.edges


def test_rule_fallback_extracts_aliases_and_redis_member_topology() -> None:
    document = Path(__file__).resolve().parents[2] / "examples" / "architecture-redis-demo.md"
    extracted = RuleBasedArchitectureExtractor().extract(document.read_text(encoding="utf-8"))
    nodes = {node.name: node for node in extracted.services}
    edges = {(edge.source, edge.target, edge.type) for edge in extracted.calls}

    assert nodes["安全服务"].meta["aliases"] == ["security-service"]
    assert nodes["redis-2"].meta == {"host": "redis-2", "ip": "10.0.2.12", "port": 6379}
    assert ("API网关服务", "安全服务", "CALLS") in edges
    assert ("安全服务", "Redis生产集群", "READS") in edges
    assert ("Redis生产集群", "redis-2", "HAS_MEMBER") in edges


def test_rca_artifacts_are_written_next_to_sliding_window_output(tmp_path: Path) -> None:
    analysis = RootCauseEngine(architecture_graph()).analyze(redis_timeout_detail()).model_dump()
    LogFaultRunner()._write_rca_artifacts(tmp_path, [analysis])

    assert (tmp_path / "rca_results.json").is_file()
    report = (tmp_path / "kg_rca_report.md").read_text(encoding="utf-8")
    assert "Redis生产集群" in report
    assert "Redis生产集群 -> security-service -> api-gateway" in report
    assert "不能仅凭超时断言节点宕机" in report
