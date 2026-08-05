from __future__ import annotations

from app.hugegraph_client import HugeGraphRestClient, HugeGraphRestError
from app.models import GraphEdge, GraphNode, GraphResponse
from app.scoped_graph import ProjectScopedGraphClient
from app.service import GraphBuilderService


class FakeClient:
    def __init__(self) -> None:
        self.upserts: list[dict] = []
        self.edges: list[tuple] = []
        self.deleted_nodes: list[str] = []
        self.deleted_edges: list[tuple[str, str, str]] = []

    def read_graph(self, limit: int = 800) -> GraphResponse:
        del limit
        return GraphResponse(
            nodes=[
                GraphNode(id="1", name="project::p1::order", kind="Service", meta={"project_id": "p1", "display_name": "order"}),
                GraphNode(id="2", name="project::p1::redis", kind="Cache", meta={"project_id": "p1", "display_name": "redis"}),
                GraphNode(id="3", name="project::p2::secret", kind="Database", meta={"project_id": "p2", "display_name": "secret"}),
                GraphNode(id="4", name="project::p1::Incident:batch:I00001", kind="Incident", meta={"project_id": "p1", "display_name": "Incident:batch:I00001"}),
                GraphNode(id="5", name="project::p1::RCAHypothesis:batch:I00001:01", kind="RCAHypothesis", meta={"project_id": "p1", "display_name": "RCAHypothesis:batch:I00001:01", "chain": ["redis", "order"]}),
                GraphNode(id="6", name="project::p1::LogEvent:batch:I00001:001", kind="LogEvent", meta={"project_id": "p1", "display_name": "LogEvent:batch:I00001:001"}),
                GraphNode(id="7", name="project::p1::unknown-runtime-service", kind="Service", meta={"project_id": "p1", "display_name": "unknown-runtime-service", "dynamic_observation": True}),
                GraphNode(id="8", name="project::p1::legacy-runtime-service", kind="Service", description="异常链路关联到的服务", meta={"project_id": "p1", "display_name": "legacy-runtime-service", "raw_service": "legacy-runtime-service"}),
            ],
            edges=[
                GraphEdge(id="e1", source="project::p1::order", target="project::p1::redis", type="DEPENDS_ON"),
                GraphEdge(id="e2", source="project::p1::order", target="project::p2::secret", type="CALLS"),
                GraphEdge(id="e3", source="project::p1::Incident:batch:I00001", target="project::p1::RCAHypothesis:batch:I00001:01", type="HAS_HYPOTHESIS"),
                GraphEdge(id="e4", source="project::p1::RCAHypothesis:batch:I00001:01", target="project::p1::redis", type="CANDIDATE_CAUSE"),
                GraphEdge(id="e5", source="project::p1::Incident:batch:I00001", target="project::p1::order", type="ROOT_SERVICE"),
                GraphEdge(id="e6", source="project::p1::Incident:batch:I00001", target="project::p1::LogEvent:batch:I00001:001", type="HAS_EVENT"),
            ],
        )

    def upsert_node(self, name, layer, kind, description, source_file, meta):
        item = {"id": f"id:{name}", "name": name, "layer": layer, "kind": kind, "description": description, "source_file": source_file, "meta": meta}
        self.upserts.append(item)
        return item

    def add_edge_by_names(self, source, target, relation, description, meta):
        self.edges.append((source, target, relation, description, meta))
        return {"id": "edge-id"}

    def delete_node_by_name(self, name):
        self.deleted_nodes.append(name)
        return True

    def delete_edge_by_tuple(self, source, target, relation):
        self.deleted_edges.append((source, target, relation))
        return True


def test_scoped_read_hides_other_project_and_strips_namespaces() -> None:
    client = ProjectScopedGraphClient("p1", FakeClient())
    graph = client.read_graph()
    assert "secret" not in {node.name for node in graph.nodes}
    assert ("order", "redis") in {(edge.source, edge.target) for edge in graph.edges}


def test_architecture_view_excludes_incident_and_runtime_observation_nodes() -> None:
    client = ProjectScopedGraphClient("p1", FakeClient())
    graph = client.read_architecture_graph()
    assert [node.name for node in graph.nodes] == ["order", "redis"]
    assert [(edge.source, edge.target, edge.type) for edge in graph.edges] == [
        ("order", "redis", "DEPENDS_ON")
    ]


def test_incident_fusion_graph_is_scoped_and_events_are_expandable() -> None:
    client = ProjectScopedGraphClient("p1", FakeClient())
    compact = client.read_incident_graph("batch:I00001", include_events=False)
    compact_names = {node.name for node in compact.nodes}
    assert {"Incident:batch:I00001", "RCAHypothesis:batch:I00001:01", "redis", "order"} <= compact_names
    assert "LogEvent:batch:I00001:001" not in compact_names

    expanded = client.read_incident_graph("batch:I00001", include_events=True)
    assert "LogEvent:batch:I00001:001" in {node.name for node in expanded.nodes}


def test_scoped_writes_add_project_namespace_and_metadata() -> None:
    fake = FakeClient()
    client = ProjectScopedGraphClient("p1", fake)
    client.upsert_node("order", "服务层", "Service", meta={"owner": "team-a"})
    client.add_edge_by_names("order", "redis", "DEPENDS_ON")

    assert fake.upserts[0]["name"] == "project::p1::order"
    assert fake.upserts[0]["meta"]["project_id"] == "p1"
    assert fake.upserts[0]["meta"]["display_name"] == "order"
    assert fake.edges[0][:3] == (
        "project::p1::order",
        "project::p1::redis",
        "DEPENDS_ON",
    )


def test_node_rename_migrates_adjacent_edges_and_removes_old_node() -> None:
    fake = FakeClient()
    client = ProjectScopedGraphClient("p1", fake)
    client.update_node_by_name("order", {"name": "checkout"})

    assert fake.upserts[0]["name"] == "project::p1::checkout"
    migrated = {(edge[0], edge[1], edge[2]) for edge in fake.edges}
    assert (
        "project::p1::checkout",
        "project::p1::redis",
        "DEPENDS_ON",
    ) in migrated
    assert "project::p1::order" in fake.deleted_nodes


def test_edge_update_deletes_old_tuple_then_creates_new_tuple() -> None:
    fake = FakeClient()
    client = ProjectScopedGraphClient("p1", fake)
    client.update_edge_by_tuple(
        "order",
        "redis",
        "DEPENDS_ON",
        "order",
        "redis",
        "USES_DB",
        "cache access",
        {"environment": "prod"},
    )

    assert fake.deleted_edges == [
        ("project::p1::order", "project::p1::redis", "DEPENDS_ON")
    ]
    assert fake.edges[-1][:4] == (
        "project::p1::order",
        "project::p1::redis",
        "USES_DB",
        "cache access",
    )


def test_namespaced_lookup_never_matches_another_projects_display_name() -> None:
    client = HugeGraphRestClient()
    client.list_vertices = lambda limit=10000: [  # type: ignore[method-assign]
        {
            "id": "p2-id",
            "properties": {
                client.pk_name: "project::p2::order",
                client.pk_meta: '{"project_id":"p2","display_name":"order"}',
            },
        },
        {
            "id": "p1-id",
            "properties": {
                client.pk_name: "project::p1::order",
                client.pk_meta: '{"project_id":"p1","display_name":"order"}',
            },
        },
    ]

    assert client.find_node_by_name("project::p1::order")["id"] == "p1-id"
    assert client.find_node_by_name("project::p3::order") is None


def test_upsert_updates_existing_primary_key_without_second_post() -> None:
    client = HugeGraphRestClient()
    client.ensure_schema = lambda: []  # type: ignore[method-assign]
    client.find_node_by_name = lambda name: {"id": "existing-id"}  # type: ignore[method-assign]
    updates: list[tuple] = []
    client.update_node_by_id = lambda *args: updates.append(args) or {"id": "existing-id"}  # type: ignore[method-assign]
    client._request = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("POST must not run"))  # type: ignore[method-assign]

    result = client.upsert_node("project::p1::order", kind="Service")

    assert result["id"] == "existing-id"
    assert updates[0][0] == "existing-id"


def test_deleted_primary_key_can_be_recreated_and_read_again() -> None:
    client = HugeGraphRestClient()
    client.ensure_schema = lambda: []  # type: ignore[method-assign]
    vertices = [
        {
            "id": "stable-primary-key-id",
            "properties": {
                client.pk_name: "project::p1::order",
                client.pk_kind: "Service",
                client.pk_meta: '{"project_id":"p1","display_name":"order"}',
            },
        }
    ]
    client.list_vertices = lambda limit=800: list(vertices)  # type: ignore[method-assign]
    client.list_edges = lambda limit=1600: []  # type: ignore[method-assign]

    def request(method: str, path: str, **kwargs) -> dict | None:
        if method == "DELETE":
            vertices.clear()
            return None
        if method == "POST" and path == "graph/vertices":
            payload = kwargs["json_body"]
            recreated = {
                "id": "stable-primary-key-id",
                "properties": dict(payload["properties"]),
            }
            vertices.append(recreated)
            return recreated
        raise AssertionError(f"unexpected request: {method} {path}")

    client._request = request  # type: ignore[method-assign]

    assert client.delete_node_by_name("project::p1::order") is True
    assert client.read_graph().nodes == []

    recreated = client.upsert_node("project::p1::order", kind="Service")
    graph = client.read_graph()

    assert recreated["id"] == "stable-primary-key-id"
    assert [node.name for node in graph.nodes] == ["project::p1::order"]


def test_node_delete_reports_failure_when_hugegraph_rejects_every_id() -> None:
    client = HugeGraphRestClient()
    client.ensure_schema = lambda: []  # type: ignore[method-assign]
    client.find_node_by_name = lambda name: {"id": "vertex-id"}  # type: ignore[method-assign]
    client.list_edges = lambda limit=10000: []  # type: ignore[method-assign]
    client._request = lambda *args, **kwargs: (_ for _ in ()).throw(  # type: ignore[method-assign]
        HugeGraphRestError("delete rejected")
    )

    assert client.delete_node_by_name("project::p1::order") is False


def test_graph_builder_creates_edges_by_name_when_node_update_has_no_id() -> None:
    class FakeBuilderDb:
        def __init__(self) -> None:
            self.edges: list[tuple[str, str, str]] = []

        def ensure_schema(self) -> list[str]:
            return []

        def upsert_node(self, **kwargs) -> dict:
            return {}

        def add_edge_by_names(
            self,
            source: str,
            target: str,
            relation: str,
            description: str,
            meta: dict,
        ) -> dict:
            del description, meta
            self.edges.append((source, target, relation))
            return {"id": "edge-id"}

    class FakeAnalyzer:
        last_mode = "test"
        last_logs: list[str] = []

        def analyze_architecture(self, text: str) -> dict:
            del text
            return {
                "services": [
                    {"name": "order", "kind": "Service"},
                    {"name": "redis", "kind": "Cache"},
                ],
                "calls": [
                    {"source": "order", "target": "redis", "type": "DEPENDS_ON"},
                ],
            }

    db = FakeBuilderDb()
    builder = GraphBuilderService(db=db)  # type: ignore[arg-type]
    builder.analyzer = FakeAnalyzer()  # type: ignore[assignment]

    builder.build_ontology_graph("order depends on redis")

    assert db.edges == [("order", "redis", "DEPENDS_ON")]
