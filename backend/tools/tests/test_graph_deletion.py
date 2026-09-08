"""Offline deletion regression checks; never connect to a real HugeGraph."""
import unittest
from unittest.mock import Mock, patch
from urllib.parse import unquote
import json

from app.hugegraph_client import HugeGraphRestClient, HugeGraphRestError
from app.scoped_graph import ProjectScopedGraphClient
from app.system_api import _graph_delete_result


class MemoryGraph(HugeGraphRestClient):
    def __init__(self, node_count=5, edge_count=8):
        super().__init__()
        self._schema_ready = True
        self.calls = []
        self.fail_delete = False
        self.vertices = [
            {"id": f"v{i}", "label": self.node_label, "properties": {self.pk_name: f"project::p1::node{i}"}}
            for i in range(node_count)
        ]
        self.edges = [
            {"id": f"e{i}", "label": self.edge_label, "outV": f"v{i % node_count}",
             "inV": f"v{(i + 1) % node_count}", "properties": {self.pk_relation_type: "CALLS"}}
            for i in range(edge_count)
        ]

    def _request(self, method, path, *, params=None, **kwargs):
        self.calls.append((method, path, params))
        if method == "GET":
            records = self.vertices if path == "graph/vertices" else self.edges
            offset = int(params.get("page") or 0)
            end = offset + params["limit"]
            entity = path.split("/")[-1]
            return {entity: records[offset:end], "page": str(end) if end < len(records) else None}
        if self.fail_delete:
            raise HugeGraphRestError("test server unavailable", status_code=503)
        if path.startswith("graph/edges/"):
            edge_id = unquote(path.split("/", 2)[-1])
            self.edges = [e for e in self.edges if e["id"] != edge_id]
        else:
            vertex_id = json.loads(unquote(path.split("/", 2)[-1]))
            self.vertices = [v for v in self.vertices if v["id"] != vertex_id]


class GraphDeletionTests(unittest.TestCase):
    def test_5000_nodes_15000_edges_are_scanned_once_not_per_edge(self):
        client = MemoryGraph(5000, 15000)
        scoped = ProjectScopedGraphClient("p1", client)
        # These former N+1 paths must never run during deletion.
        client.find_node_by_name = Mock(side_effect=AssertionError("per-node lookup"))
        client._vertex_name_by_id = Mock(side_effect=AssertionError("per-edge lookup"))
        result = scoped.batch_delete_edges([{"source": "node4999", "target": "node0", "type": "CALLS"}])
        self.assertEqual(result["deleted_edges"], 3)  # Includes a match beyond edge 10000.
        reads = [call for call in client.calls if call[0] == "GET"]
        self.assertEqual(len(reads), 11)  # 3 vertex pages + 8 edge pages.
        self.assertEqual(len(client.edges), 14997)

    def test_batch_nodes_share_one_snapshot_and_delete_shared_edge_once(self):
        client = MemoryGraph(5000, 15000)
        result = ProjectScopedGraphClient("p1", client).batch_delete_nodes(["node0", "node1", "node0"])
        self.assertEqual(result, {"deleted_nodes": 2, "deleted_edges": 9, "not_found_nodes": 0})
        self.assertEqual(sum(c[0] == "GET" for c in client.calls), 11)
        self.assertFalse(any(e["outV"] in {"v0", "v1"} or e["inV"] in {"v0", "v1"} for e in client.edges))
        deleted_ids = [path for method, path, _ in client.calls if method == "DELETE"]
        self.assertEqual(len(deleted_ids), len(set(deleted_ids)))

    def test_single_node_keeps_project_isolation_and_no_raw_name_fallback(self):
        client = MemoryGraph()
        client.vertices[0]["properties"][client.pk_name] = "project::p2::node0"
        client.vertices[1]["properties"][client.pk_name] = "node0"
        self.assertFalse(ProjectScopedGraphClient("p1", client).delete_node_by_name("node0"))
        self.assertFalse(any(c[0] == "DELETE" for c in client.calls))

    def test_single_edge_preserves_direction_type_and_other_projects(self):
        client = MemoryGraph()
        client.edges.append({"id": "reverse", "label": client.edge_label, "outV": "v1", "inV": "v0", "properties": {client.pk_relation_type: "CALLS"}})
        client.edges.append({"id": "other-type", "label": client.edge_label, "outV": "v0", "inV": "v1", "properties": {client.pk_relation_type: "DEPENDS_ON"}})
        scoped = ProjectScopedGraphClient("p1", client)
        self.assertTrue(scoped.delete_edge_by_tuple("node0", "node1", "CALLS"))
        ids = {edge["id"] for edge in client.edges}
        self.assertTrue({"reverse", "other-type"}.issubset(ids))

    def test_missing_targets_report_zero(self):
        client = MemoryGraph()
        scoped = ProjectScopedGraphClient("p1", client)
        self.assertEqual(scoped.batch_delete_nodes(["missing"])["not_found_nodes"], 1)
        self.assertEqual(scoped.batch_delete_edges([{"source": "missing", "target": "node1"}]), {"deleted_edges": 0, "not_found_edges": 1})

    def test_server_error_is_not_silently_reported_as_not_found(self):
        client = MemoryGraph()
        client.fail_delete = True
        with self.assertRaises(HugeGraphRestError):
            ProjectScopedGraphClient("p1", client).delete_node_by_name("node0")
        self.assertFalse(any(c[0] == "DELETE" and c[1].startswith("graph/vertices/") for c in client.calls))

    def test_vertex_timeout_is_not_retried(self):
        client = MemoryGraph()
        with patch.object(client, "_request", side_effect=HugeGraphRestError("timeout")) as request:
            with self.assertRaises(HugeGraphRestError):
                client._delete_vertex_by_id("test/name")
        request.assert_called_once()

    def test_not_found_edge_is_not_a_server_failure(self):
        client = MemoryGraph()
        with patch.object(client, "_request", side_effect=HugeGraphRestError("gone", status_code=404)):
            self.assertFalse(client.delete_edge_by_id("gone"))

    def test_incomplete_paging_stops_before_any_delete(self):
        client = MemoryGraph()
        with patch.object(client, "_request", return_value={"vertices": client.vertices}) as request:
            with self.assertRaises(HugeGraphRestError):
                client.batch_delete_nodes(["project::p1::node0"])
        self.assertTrue(all(call.args[0] == "GET" for call in request.call_args_list))

    def test_repeated_cursor_stops_before_any_delete(self):
        client = MemoryGraph()
        with patch.object(client, "_request", return_value={"vertices": client.vertices, "page": "same"}) as request:
            with self.assertRaises(HugeGraphRestError):
                client.batch_delete_nodes(["project::p1::node0"])
        self.assertEqual(request.call_count, 2)

    def test_deletes_only_application_labels(self):
        client = MemoryGraph()
        client.vertices[0]["label"] = "DifferentApplication"
        self.assertEqual(client.batch_delete_nodes(["project::p1::node0"])["deleted_nodes"], 0)

    def test_graph_refresh_failure_preserves_success_result(self):
        client = Mock(project_id="p1")
        client.read_architecture_graph.side_effect = HugeGraphRestError("read timed out")
        with patch("app.system_api.logger"):
            result = _graph_delete_result(client, {"deleted_nodes": 2, "deleted_edges": 4})
        self.assertEqual(result["deleted_nodes"], 2)
        self.assertIsNone(result["graph"])
        self.assertIn("不要重复提交删除", result["refresh_warning"])


if __name__ == "__main__":
    unittest.main()
