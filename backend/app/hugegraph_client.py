from __future__ import annotations

import json
import re
import urllib.parse
from typing import Any

import requests

from .config import get_settings
from .models import GraphEdge, GraphNode, GraphResponse


class HugeGraphRestError(RuntimeError):
    pass


class HugeGraphRestClient:
    """HugeGraph REST API client, no Gremlin involved.

    It supports both URL styles:
    - HugeGraph 1.7+ graphspace: /graphspaces/DEFAULT/graphs/hugegraph
    - legacy: /graphs/hugegraph

    This class intentionally uses REST vertex/edge APIs like the referenced
    logsys project's database.py, not /gremlin, so there are no g/__g_hugegraph
    binding errors.
    """

    def __init__(self) -> None:
        self.settings = get_settings()
        self.host = self.settings.hugegraph_host
        self.port = self.settings.hugegraph_port
        self.graphspace = self.settings.hugegraph_graphspace
        self.graph = self.settings.hugegraph_graph
        self.timeout = self.settings.hugegraph_timeout_seconds
        self.headers = {"Content-Type": "application/json"}
        self.session = requests.Session()
        self.session.trust_env = False
        self._base_url: str | None = None

        self.node_label = self.settings.node_label
        self.edge_label = self.settings.edge_label

        self.pk_name = "logsys_kg_name"
        self.pk_layer = "logsys_kg_layer"
        self.pk_kind = "logsys_kg_kind"
        self.pk_desc = "logsys_kg_description"
        self.pk_source_file = "logsys_kg_source_file"
        self.pk_relation_key = "logsys_kg_relation_key"
        self.pk_relation_type = "logsys_kg_relation_type"
        self.pk_relation_desc = "logsys_kg_relation_desc"

    def base_candidates(self) -> list[str]:
        root = f"http://{self.host}:{self.port}"
        return [
            f"{root}/graphspaces/{self.graphspace}/graphs/{self.graph}",
            f"{root}/graphs/{self.graph}",
        ]

    def ping(self) -> dict[str, Any]:
        root = f"http://{self.host}:{self.port}"
        result: dict[str, Any] = {
            "root": root,
            "candidates": self.base_candidates(),
            "selected_base_url": None,
            "node_label": self.node_label,
            "edge_label": self.edge_label,
        }
        try:
            r = self.session.get(f"{root}/versions", timeout=self.timeout)
            result["versions_status"] = r.status_code
            result["versions_body"] = self._safe_body(r)
        except Exception as exc:  # noqa: BLE001
            result["versions_error"] = str(exc)

        result["base_checks"] = []
        for base in self.base_candidates():
            try:
                r = self.session.get(f"{base}/schema", timeout=self.timeout)
                result["base_checks"].append({"base_url": base, "status": r.status_code, "body": self._safe_body(r)})
                if r.status_code == 200 and result["selected_base_url"] is None:
                    result["selected_base_url"] = base
            except Exception as exc:  # noqa: BLE001
                result["base_checks"].append({"base_url": base, "error": str(exc)})
        if result["selected_base_url"]:
            self._base_url = result["selected_base_url"]
            result["status"] = "ok"
        else:
            result["status"] = "failed"
        return result

    def _safe_body(self, response: requests.Response) -> Any:
        try:
            return response.json()
        except Exception:
            return response.text[:2000]

    def _resolve_base_url(self) -> str:
        if self._base_url:
            return self._base_url
        errors: list[str] = []
        for base in self.base_candidates():
            try:
                r = self.session.get(f"{base}/schema", headers=self.headers, timeout=self.timeout)
                if r.status_code == 200:
                    self._base_url = base
                    return base
                errors.append(f"GET {base}/schema -> {r.status_code}: {r.text[:500]}")
            except Exception as exc:  # noqa: BLE001
                errors.append(f"GET {base}/schema -> {exc}")
        raise HugeGraphRestError("无法连接 HugeGraph REST API。尝试过: " + " | ".join(errors))

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any | None = None,
        params: dict[str, Any] | None = None,
        expected: tuple[int, ...] = (200,),
    ) -> Any:
        base = self._resolve_base_url()
        url = f"{base}/{path.lstrip('/')}"
        try:
            response = self.session.request(
                method,
                url,
                json=json_body,
                params=params,
                headers=self.headers,
                timeout=self.timeout,
            )
        except Exception as exc:  # noqa: BLE001
            raise HugeGraphRestError(f"HugeGraph 请求失败: {method} {url}: {exc}") from exc

        if response.status_code not in expected:
            raise HugeGraphRestError(f"HugeGraph HTTP {response.status_code}: {method} {url}: {response.text[:3000]}")
        if response.status_code == 204 or not response.text:
            return None
        return self._safe_body(response)

    def _post_schema_ignore_exists(self, path: str, payload: dict[str, Any]) -> str:
        try:
            self._request("POST", path, json_body=payload, expected=(200, 201, 202))
            return f"created {path}: {payload.get('name')}"
        except HugeGraphRestError as exc:
            msg = str(exc).lower()
            if "exist" in msg or "already" in msg or "created" in msg:
                return f"exists {path}: {payload.get('name')}"
            if self._schema_name_exists(path, str(payload.get("name", ""))):
                return f"exists {path}: {payload.get('name')}"
            raise

    def _schema(self) -> dict[str, Any]:
        data = self._request("GET", "schema", expected=(200,))
        return data if isinstance(data, dict) else {}

    def _schema_name_exists(self, path: str, name: str) -> bool:
        if not name:
            return False
        schema = self._schema()
        section_name = ""
        if "propertykeys" in path:
            section_name = "propertykeys"
        elif "vertexlabels" in path:
            section_name = "vertexlabels"
        elif "edgelabels" in path:
            section_name = "edgelabels"
        elif "indexlabels" in path:
            section_name = "indexlabels"
        section = schema.get(section_name, [])
        return any(isinstance(x, dict) and x.get("name") == name for x in section)

    def _get_schema_item(self, section_name: str, name: str) -> dict[str, Any] | None:
        for item in self._schema().get(section_name, []):
            if isinstance(item, dict) and item.get("name") == name:
                return item
        return None

    def _schema_safe_name(self, value: str) -> str:
        value = re.sub(r"[^0-9A-Za-z_]", "_", value)
        return value[:80] or "LogSysKG"

    def _ensure_edge_label_compatible_or_switch(self, logs: list[str]) -> None:
        existing = self._get_schema_item("edgelabels", self.edge_label)
        if not existing:
            return

        props = set(existing.get("properties") or [])
        sort_keys = set(existing.get("sort_keys") or existing.get("sortKeys") or [])
        ok = self.pk_relation_key in props and self.pk_relation_key in sort_keys
        if ok:
            return

        old = self.edge_label
        self.edge_label = f"{old}_V3_FIXED"
        logs.append(
            f"检测到旧边类型 {old} 缺少 sort_keys 或 relation_key，自动切换到新边类型 {self.edge_label}。"
        )

    def ensure_schema(self) -> list[str]:
        logs: list[str] = []

        # 1) Property keys
        for name in [
            self.pk_name,
            self.pk_layer,
            self.pk_kind,
            self.pk_desc,
            self.pk_source_file,
            self.pk_relation_key,
            self.pk_relation_type,
            self.pk_relation_desc,
        ]:
            logs.append(
                self._post_schema_ignore_exists(
                    "schema/propertykeys",
                    {"name": name, "data_type": "TEXT", "cardinality": "SINGLE"},
                )
            )

        # 2) Vertex label
        logs.append(
            self._post_schema_ignore_exists(
                "schema/vertexlabels",
                {
                    "name": self.node_label,
                    "id_strategy": "PRIMARY_KEY",
                    "primary_keys": [self.pk_name],
                    "properties": [self.pk_name, self.pk_layer, self.pk_kind, self.pk_desc, self.pk_source_file],
                    "nullable_keys": [self.pk_layer, self.pk_kind, self.pk_desc, self.pk_source_file],
                },
            )
        )

        # 3) Edge label. HugeGraph requires sort_keys for MULTIPLE edge labels.
        # Earlier code omitted it, causing: EdgeLabel must contain sortKeys when
        # the cardinality/frequency is multiple.
        self._ensure_edge_label_compatible_or_switch(logs)
        logs.append(
            self._post_schema_ignore_exists(
                "schema/edgelabels",
                {
                    "name": self.edge_label,
                    "source_label": self.node_label,
                    "target_label": self.node_label,
                    "frequency": "MULTIPLE",
                    "sort_keys": [self.pk_relation_key],
                    "properties": [self.pk_relation_key, self.pk_relation_type, self.pk_relation_desc],
                    "nullable_keys": [self.pk_relation_desc],
                },
            )
        )

        # 4) Optional indexes. If a HugeGraph version rejects these or they
        # already exist with another schema, skip; rendering does not depend on them.
        index_prefix = self._schema_safe_name(f"{self.node_label}_{self.edge_label}")
        for payload in [
            {
                "name": f"{index_prefix}_node_kind",
                "base_type": "VERTEX_LABEL",
                "base_value": self.node_label,
                "index_type": "SECONDARY",
                "fields": [self.pk_kind],
            },
            {
                "name": f"{index_prefix}_edge_type",
                "base_type": "EDGE_LABEL",
                "base_value": self.edge_label,
                "index_type": "SECONDARY",
                "fields": [self.pk_relation_type],
            },
        ]:
            try:
                logs.append(self._post_schema_ignore_exists("schema/indexlabels", payload))
            except HugeGraphRestError as exc:
                logs.append(f"skip optional index {payload['name']}: {exc}")
        return logs

    def upsert_node(self, name: str, layer: str, kind: str, description: str, source_file: str) -> dict[str, Any]:
        payload = {
            "label": self.node_label,
            "properties": {
                self.pk_name: name,
                self.pk_layer: layer or "Component层",
                self.pk_kind: kind or "Component",
                self.pk_desc: description or "",
                self.pk_source_file: source_file or "",
            },
        }
        try:
            return self._request("POST", "graph/vertices", json_body=payload, expected=(200, 201, 202))
        except HugeGraphRestError as exc:
            msg = str(exc).lower()
            if "exist" in msg or "duplicate" in msg or "already" in msg:
                existing = self.find_node_by_name(name)
                if existing:
                    return existing
            raise

    def find_node_by_name(self, name: str) -> dict[str, Any] | None:
        for vertex in self.list_vertices(limit=10000):
            if (vertex.get("properties") or {}).get(self.pk_name) == name:
                return vertex
        return None

    def _relation_key(self, source_id: str, target_id: str, relation_type: str) -> str:
        return f"{source_id}|{relation_type or 'CALLS'}|{target_id}"

    def add_edge(self, source_id: str, target_id: str, relation_type: str, description: str) -> dict[str, Any]:
        relation_key = self._relation_key(source_id, target_id, relation_type)
        payload = {
            "label": self.edge_label,
            "outV": source_id,
            "inV": target_id,
            "outVLabel": self.node_label,
            "inVLabel": self.node_label,
            "properties": {
                self.pk_relation_key: relation_key,
                self.pk_relation_type: relation_type or "CALLS",
                self.pk_relation_desc: description or "",
            },
        }
        try:
            return self._request("POST", "graph/edges", json_body=payload, expected=(200, 201, 202))
        except HugeGraphRestError as exc:
            # Re-uploading the same file may create the same sorted edge. Treat it
            # as idempotent for the demo.
            msg = str(exc).lower()
            if "exist" in msg or "duplicate" in msg or "already" in msg:
                return {"id": "exists", "label": self.edge_label, "properties": payload["properties"]}
            raise

    def list_vertices(self, limit: int = 800) -> list[dict[str, Any]]:
        try:
            data = self._request(
                "GET",
                "graph/vertices",
                params={"label": self.node_label, "limit": limit},
                expected=(200,),
            )
            if isinstance(data, dict):
                return data.get("vertices", []) or []
            if isinstance(data, list):
                return data
            return []
        except HugeGraphRestError as exc:
            if "does not exist" in str(exc).lower() or "not exist" in str(exc).lower():
                return []
            raise

    def list_edges(self, limit: int = 1600) -> list[dict[str, Any]]:
        try:
            data = self._request(
                "GET",
                "graph/edges",
                params={"label": self.edge_label, "limit": limit},
                expected=(200,),
            )
            if isinstance(data, dict):
                return data.get("edges", []) or []
            if isinstance(data, list):
                return data
            return []
        except HugeGraphRestError as exc:
            if "does not exist" in str(exc).lower() or "not exist" in str(exc).lower():
                return []
            raise

    def read_graph(self, limit: int = 800) -> GraphResponse:
        self.ensure_schema()
        vertices = self.list_vertices(limit=limit)
        edges = self.list_edges(limit=limit * 2)

        id_to_name: dict[str, str] = {}
        nodes: list[GraphNode] = []
        for v in vertices:
            props = v.get("properties", {}) or {}
            node_id = str(v.get("id"))
            name = str(props.get(self.pk_name) or node_id)
            id_to_name[node_id] = name
            nodes.append(
                GraphNode(
                    id=name,
                    name=name,
                    layer=str(props.get(self.pk_layer) or "Component层"),
                    kind=str(props.get(self.pk_kind) or "Component"),
                    description=str(props.get(self.pk_desc) or ""),
                )
            )

        graph_edges: list[GraphEdge] = []
        seen: set[tuple[str, str, str]] = set()
        for e in edges:
            props = e.get("properties", {}) or {}
            source = id_to_name.get(str(e.get("outV")))
            target = id_to_name.get(str(e.get("inV")))
            if not source or not target:
                continue
            rel_type = str(props.get(self.pk_relation_type) or "CALLS")
            key = (source, target, rel_type)
            if key in seen:
                continue
            seen.add(key)
            graph_edges.append(
                GraphEdge(
                    id=str(e.get("id") or props.get(self.pk_relation_key) or ""),
                    source=source,
                    target=target,
                    type=rel_type,
                    description=str(props.get(self.pk_relation_desc) or ""),
                )
            )

        return GraphResponse(nodes=nodes, edges=graph_edges)

    def clear_logsys_graph(self) -> dict[str, int]:
        self.ensure_schema()
        edge_count = 0
        for edge in self.list_edges(limit=10000):
            edge_id = str(edge.get("id") or "")
            if not edge_id:
                continue
            encoded = urllib.parse.quote(edge_id, safe="")
            try:
                self._request("DELETE", f"graph/edges/{encoded}", expected=(200, 202, 204))
                edge_count += 1
            except HugeGraphRestError:
                pass

        vertex_count = 0
        for vertex in self.list_vertices(limit=10000):
            vertex_id = str(vertex.get("id") or "")
            if not vertex_id:
                continue
            # HugeGraph vertex id for primary-key labels is a JSON-like string in
            # many versions; try both raw and JSON-encoded URL variants.
            encoded_candidates = [
                urllib.parse.quote(vertex_id, safe=""),
                urllib.parse.quote(json.dumps(vertex_id, ensure_ascii=False), safe=""),
            ]
            for encoded in encoded_candidates:
                try:
                    self._request("DELETE", f"graph/vertices/{encoded}", params={"label": self.node_label}, expected=(200, 202, 204))
                    vertex_count += 1
                    break
                except HugeGraphRestError:
                    continue
        return {"deleted_edges": edge_count, "deleted_vertices": vertex_count}
