from __future__ import annotations

from typing import Any

from .hugegraph_client import HugeGraphRestClient
from .models import GraphEdge, GraphNode, GraphResponse


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


class ProjectScopedGraphClient:
    """Namespace every HugeGraph entity so projects cannot collide."""

    def __init__(self, project_id: str, client: HugeGraphRestClient | None = None) -> None:
        self.project_id = project_id
        self.client = client or HugeGraphRestClient()
        self.prefix = f"project::{project_id}::"

    def __getattr__(self, name: str) -> Any:
        return getattr(self.client, name)

    def _name(self, value: str) -> str:
        value = str(value or "")
        return value if value.startswith(self.prefix) else f"{self.prefix}{value}"

    def _display(self, value: str) -> str:
        return value[len(self.prefix):] if value.startswith(self.prefix) else value

    def _meta(self, name: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
        return {**(meta or {}), "project_id": self.project_id, "display_name": self._display(name)}

    def ensure_schema(self) -> list[str]:
        return self.client.ensure_schema()

    def upsert_node(
        self,
        name: str,
        layer: str = "Component层",
        kind: str = "Component",
        description: str = "",
        source_file: str = "",
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        internal = self._name(name)
        return self.client.upsert_node(
            internal,
            layer,
            kind,
            description,
            source_file,
            self._meta(name, meta),
        )

    def find_node_by_name(self, name: str) -> dict[str, Any] | None:
        return self.client.find_node_by_name(self._name(name))

    def add_edge(
        self,
        source_id: str,
        target_id: str,
        relation_type: str = "CALLS",
        description: str = "",
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.client.add_edge(
            source_id,
            target_id,
            relation_type,
            description,
            {**(meta or {}), "project_id": self.project_id},
        )

    def add_edge_by_names(
        self,
        source_name: str,
        target_name: str,
        relation_type: str = "CALLS",
        description: str = "",
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.client.add_edge_by_names(
            self._name(source_name),
            self._name(target_name),
            relation_type,
            description,
            {**(meta or {}), "project_id": self.project_id},
        )

    def update_node_by_name(self, original_name: str, data: dict[str, Any]) -> dict[str, Any]:
        payload = dict(data)
        new_name = str(payload.get("name") or original_name)
        if new_name != original_name:
            # HugeGraph primary keys cannot be renamed in place. Recreate the
            # node, migrate every adjacent architecture/RCA edge, then remove
            # the old node so editing a name does not leave a duplicate behind.
            graph = self.read_graph(limit=5000)
            current = next((node for node in graph.nodes if node.name == original_name), None)
            if current is None:
                raise ValueError(f"未找到节点: {original_name}")
            saved = self.upsert_node(
                name=new_name,
                layer=str(payload.get("layer") if payload.get("layer") is not None else current.layer),
                kind=str(payload.get("kind") if payload.get("kind") is not None else current.kind),
                description=str(
                    payload.get("description")
                    if payload.get("description") is not None
                    else current.description
                ),
                source_file=str(
                    payload.get("source_file")
                    if payload.get("source_file") is not None
                    else current.source_file
                ),
                meta=(
                    payload.get("meta")
                    if isinstance(payload.get("meta"), dict)
                    else current.meta
                ),
            )
            adjacent = [
                edge
                for edge in graph.edges
                if edge.source == original_name or edge.target == original_name
            ]
            for edge in adjacent:
                source = new_name if edge.source == original_name else edge.source
                target = new_name if edge.target == original_name else edge.target
                if source != target:
                    self.add_edge_by_names(
                        source,
                        target,
                        edge.type,
                        edge.description,
                        edge.meta,
                    )
            self.delete_node_by_name(original_name)
            return saved
        payload["name"] = self._name(new_name)
        if "meta" in payload:
            payload["meta"] = self._meta(
                new_name,
                payload.get("meta") if isinstance(payload.get("meta"), dict) else {},
            )
        return self.client.update_node_by_name(self._name(original_name), payload)

    def delete_node_by_name(self, name: str) -> bool:
        return self.client.delete_node_by_name(self._name(name))

    def delete_edge_by_tuple(self, source_name: str, target_name: str, relation_type: str = "CALLS") -> bool:
        return self.client.delete_edge_by_tuple(
            self._name(source_name),
            self._name(target_name),
            relation_type,
        )

    def update_edge_by_tuple(
        self,
        original_source: str,
        original_target: str,
        original_type: str,
        source: str,
        target: str,
        relation_type: str,
        description: str = "",
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        old_graph = self.read_graph(limit=5000)
        old_edge = next(
            (
                edge
                for edge in old_graph.edges
                if edge.source == original_source
                and edge.target == original_target
                and edge.type == original_type
            ),
            None,
        )
        if not self.delete_edge_by_tuple(original_source, original_target, original_type):
            raise ValueError("未找到要编辑的关系")
        try:
            return self.add_edge_by_names(
                source,
                target,
                relation_type,
                description,
                meta,
            )
        except Exception:
            # Best-effort rollback preserves the old topology if the new edge
            # cannot be created (for example, an endpoint was deleted).
            self.add_edge_by_names(
                original_source,
                original_target,
                original_type,
                old_edge.description if old_edge else "",
                old_edge.meta if old_edge else {},
            )
            raise

    def read_graph(self, limit: int = 800) -> GraphResponse:
        # REST list endpoints are global to the vertex label.  Read a wider
        # bounded snapshot and then enforce project isolation in memory.
        raw = self.client.read_graph(limit=min(max(limit * 10, 5000), 50000))
        nodes: list[GraphNode] = []
        allowed: set[str] = set()
        for node in raw.nodes:
            meta = node.meta or {}
            if not node.name.startswith(self.prefix) and str(meta.get("project_id") or "") != self.project_id:
                continue
            display = str(meta.get("display_name") or self._display(node.name))
            allowed.add(node.name)
            nodes.append(
                GraphNode(
                    id=display,
                    name=display,
                    layer=node.layer,
                    kind=node.kind,
                    description=node.description,
                    source_file=node.source_file,
                    meta=meta,
                )
            )

        edges: list[GraphEdge] = []
        for edge in raw.edges:
            if edge.source not in allowed or edge.target not in allowed:
                continue
            edges.append(
                GraphEdge(
                    id=edge.id,
                    source=self._display(edge.source),
                    target=self._display(edge.target),
                    type=edge.type,
                    description=edge.description,
                    meta=edge.meta,
                )
            )
        return GraphResponse(nodes=nodes, edges=edges, warnings=raw.warnings)

    def read_architecture_graph(self, limit: int = 800) -> GraphResponse:
        """Return only curated/static architecture entities and their edges."""
        graph = self.read_graph(limit=limit)
        nodes = [
            node
            for node in graph.nodes
            if node.kind not in DYNAMIC_KINDS
            and not bool((node.meta or {}).get("dynamic_observation"))
            and not (
                "raw_service" in (node.meta or {})
                and node.description == "异常链路关联到的服务"
            )
        ]
        names = {node.name for node in nodes}
        edges = [
            edge
            for edge in graph.edges
            if edge.source in names and edge.target in names
        ]
        return GraphResponse(nodes=nodes, edges=edges, warnings=graph.warnings)

    def read_incident_graph(
        self,
        incident_id: str,
        *,
        include_events: bool = False,
        event_limit: int = 30,
    ) -> GraphResponse:
        """Build one incident's fused evidence + architecture subgraph."""
        graph = self.read_graph(limit=5000)
        incident_name = incident_id if incident_id.startswith("Incident:") else f"Incident:{incident_id}"
        node_map = {node.name: node for node in graph.nodes}
        if incident_name not in node_map:
            return GraphResponse(
                nodes=[],
                edges=[],
                warnings=[f"HugeGraph 中未找到故障节点 {incident_name}"],
            )

        selected: set[str] = {incident_name}
        incident_relations = {
            "HAS_HYPOTHESIS",
            "SUSPECTED_ROOT_CAUSE",
            "ROOT_SERVICE",
            "OBSERVED_AT",
            "HAS_EXCEPTION",
            "HAS_TRACE",
        }
        for edge in graph.edges:
            if edge.source == incident_name and edge.type in incident_relations:
                selected.add(edge.target)
            elif edge.target == incident_name and edge.type in incident_relations:
                selected.add(edge.source)

        hypothesis_names = {
            name
            for name in selected
            if node_map.get(name) and node_map[name].kind == "RCAHypothesis"
        }
        for name in hypothesis_names:
            hypothesis = node_map[name]
            for chain_node in (hypothesis.meta or {}).get("chain") or []:
                if str(chain_node) in node_map:
                    selected.add(str(chain_node))
            for edge in graph.edges:
                if edge.source == name or edge.target == name:
                    selected.update((edge.source, edge.target))

        if include_events:
            event_names = [
                edge.target
                for edge in graph.edges
                if edge.source == incident_name and edge.type == "HAS_EVENT"
            ][: max(1, min(event_limit, 120))]
            selected.update(event_names)
            for edge in graph.edges:
                if edge.source in event_names or edge.target in event_names:
                    other = edge.target if edge.source in event_names else edge.source
                    other_node = node_map.get(other)
                    if other_node and (
                        other_node.kind not in DYNAMIC_KINDS
                        or other in event_names
                        or edge.type == "TEMPORALLY_PRECEDES"
                    ):
                        selected.add(other)

        # Include architecture edges between every selected chain component;
        # these stored dependency directions are the basis of the reversed
        # FAULT_PROPAGATES_TO chain shown in the RCA result.
        nodes = [node for node in graph.nodes if node.name in selected]
        edges = [
            edge
            for edge in graph.edges
            if edge.source in selected and edge.target in selected
        ]
        return GraphResponse(nodes=nodes, edges=edges, warnings=graph.warnings)

    def delete_incident_batch(self, batch_prefix: str) -> dict[str, int]:
        """Remove dynamic graph nodes created by one log-analysis batch."""
        graph = self.read_graph(limit=5000)
        token = f":{batch_prefix}:"
        targets = [
            node
            for node in graph.nodes
            if node.kind in DYNAMIC_KINDS and token in node.name
        ]
        deleted = 0
        for node in targets:
            if self.delete_node_by_name(node.name):
                deleted += 1

        # Trace and Exception nodes may be shared across incidents. Prune only
        # those left without any edge after removing this batch.
        remaining = self.read_graph(limit=5000)
        connected = {
            endpoint
            for edge in remaining.edges
            for endpoint in (edge.source, edge.target)
        }
        pruned = 0
        for node in remaining.nodes:
            if node.kind in {"Trace", "Exception"} and node.name not in connected:
                if self.delete_node_by_name(node.name):
                    pruned += 1
        return {"deleted_dynamic_nodes": deleted, "pruned_orphans": pruned}

    def clear_architecture_graph(self) -> dict[str, int]:
        graph = self.read_architecture_graph(limit=5000)
        deleted = 0
        for node in graph.nodes:
            if self.delete_node_by_name(node.name):
                deleted += 1
        return {"deleted_vertices": deleted}

    def clear_project_graph(self) -> dict[str, int]:
        graph = self.read_graph(limit=5000)
        deleted = 0
        # Raw node deletion removes adjacent project edges first.
        for node in graph.nodes:
            if self.delete_node_by_name(node.name):
                deleted += 1
        return {"deleted_vertices": deleted}
