from __future__ import annotations

import json
import re
import urllib.parse
from typing import Any

import requests

from .config import get_settings
from .models import GraphEdge, GraphNode, GraphResponse


class HugeGraphRestError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


def _json_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_dict(value: Any) -> dict[str, Any]:
    if not value:
        return {}
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            data = json.loads(value)
            return data if isinstance(data, dict) else {"value": data}
        except Exception:
            return {"text": value}
    return {"value": value}


class HugeGraphRestClient:
    """HugeGraph REST API client used by the KG UI.

    The class stays REST-only, because the referenced project already uses a
    direct REST style and this avoids Gremlin binding/version problems. It also
    adds small CRUD helpers so the UI can edit architecture and incident nodes.
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
        self._schema_ready = False

        self.node_label = self.settings.node_label
        self.edge_label = self.settings.edge_label

        self.pk_name = "logsys_kg_name"
        self.pk_layer = "logsys_kg_layer"
        self.pk_kind = "logsys_kg_kind"
        self.pk_desc = "logsys_kg_description"
        self.pk_source_file = "logsys_kg_source_file"
        self.pk_meta = "logsys_kg_meta"
        self.pk_relation_key = "logsys_kg_relation_key"
        self.pk_relation_type = "logsys_kg_relation_type"
        self.pk_relation_desc = "logsys_kg_relation_desc"
        self.pk_relation_meta = "logsys_kg_relation_meta"

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
            raise HugeGraphRestError(
                f"HugeGraph HTTP {response.status_code}: {method} {url}: {response.text[:3000]}",
                status_code=response.status_code,
            )
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
        ok = self.pk_relation_key in props and self.pk_relation_key in sort_keys and self.pk_relation_meta in props
        if ok:
            return
        old = self.edge_label
        self.edge_label = f"{old}_CRUD_FIXED"
        logs.append(f"检测到旧边类型 {old} 缺少 relation_key/sort_keys/meta，自动切换到 {self.edge_label}。")

    def _ensure_vertex_label_compatible_or_switch(self, logs: list[str]) -> None:
        existing = self._get_schema_item("vertexlabels", self.node_label)
        if not existing:
            return
        props = set(existing.get("properties") or [])
        if self.pk_meta in props:
            return
        old = self.node_label
        self.node_label = f"{old}_CRUD_FIXED"
        logs.append(f"检测到旧点类型 {old} 缺少 meta 字段，自动切换到 {self.node_label}。")

    def ensure_schema(self) -> list[str]:
        if self._schema_ready:
            return []
        logs: list[str] = []
        for name in [
            self.pk_name,
            self.pk_layer,
            self.pk_kind,
            self.pk_desc,
            self.pk_source_file,
            self.pk_meta,
            self.pk_relation_key,
            self.pk_relation_type,
            self.pk_relation_desc,
            self.pk_relation_meta,
        ]:
            logs.append(
                self._post_schema_ignore_exists(
                    "schema/propertykeys",
                    {"name": name, "data_type": "TEXT", "cardinality": "SINGLE"},
                )
            )

        self._ensure_vertex_label_compatible_or_switch(logs)
        logs.append(
            self._post_schema_ignore_exists(
                "schema/vertexlabels",
                {
                    "name": self.node_label,
                    "id_strategy": "PRIMARY_KEY",
                    "primary_keys": [self.pk_name],
                    "properties": [self.pk_name, self.pk_layer, self.pk_kind, self.pk_desc, self.pk_source_file, self.pk_meta],
                    "nullable_keys": [self.pk_layer, self.pk_kind, self.pk_desc, self.pk_source_file, self.pk_meta],
                },
            )
        )

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
                    "properties": [self.pk_relation_key, self.pk_relation_type, self.pk_relation_desc, self.pk_relation_meta],
                    "nullable_keys": [self.pk_relation_desc, self.pk_relation_meta],
                },
            )
        )

        index_prefix = self._schema_safe_name(f"{self.node_label}_{self.edge_label}")
        for payload in [
            {"name": f"{index_prefix}_node_kind", "base_type": "VERTEX_LABEL", "base_value": self.node_label, "index_type": "SECONDARY", "fields": [self.pk_kind]},
            {"name": f"{index_prefix}_edge_type", "base_type": "EDGE_LABEL", "base_value": self.edge_label, "index_type": "SECONDARY", "fields": [self.pk_relation_type]},
        ]:
            try:
                logs.append(self._post_schema_ignore_exists("schema/indexlabels", payload))
            except HugeGraphRestError as exc:
                logs.append(f"skip optional index {payload['name']}: {exc}")
        self._schema_ready = True
        return logs

    def _node_payload(self, name: str, layer: str, kind: str, description: str, source_file: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
        return {
            "label": self.node_label,
            "properties": {
                self.pk_name: name,
                self.pk_layer: layer or "Component层",
                self.pk_kind: kind or "Component",
                self.pk_desc: description or "",
                self.pk_source_file: source_file or "",
                self.pk_meta: _json_text(meta or {}),
            },
        }

    def upsert_node(
        self,
        name: str,
        layer: str = "Component层",
        kind: str = "Component",
        description: str = "",
        source_file: str = "",
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.ensure_schema()
        # PRIMARY_KEY vertex labels reject a second POST for the same name.
        # Resolve the exact vertex first so manual creation and repeated imports
        # behave as a real upsert instead of relying on server-specific errors.
        existing = self.find_node_by_name(name)
        if existing:
            return self.update_node_by_id(
                str(existing.get("id") or ""),
                name,
                layer,
                kind,
                description,
                source_file,
                meta,
            )

        payload = self._node_payload(name, layer, kind, description, source_file, meta)
        try:
            return self._request("POST", "graph/vertices", json_body=payload, expected=(200, 201, 202))
        except HugeGraphRestError:
            # A concurrent writer may have inserted the same primary key after
            # our pre-check. Re-resolve it before surfacing the create error.
            existing = self.find_node_by_name(name)
            if existing:
                return self.update_node_by_id(
                    str(existing.get("id") or ""),
                    name,
                    layer,
                    kind,
                    description,
                    source_file,
                    meta,
                )
            raise

    def upsert_nodes_bulk(self, nodes: list[dict[str, Any]]) -> int:
        count = 0
        for node in nodes:
            self.upsert_node(
                name=str(node.get("name") or ""),
                layer=str(node.get("layer") or "Component层"),
                kind=str(node.get("kind") or "Component"),
                description=str(node.get("description") or ""),
                source_file=str(node.get("source_file") or ""),
                meta=node.get("meta") if isinstance(node.get("meta"), dict) else {},
            )
            count += 1
        return count

    def _encoded_id_candidates(self, vertex_id: str) -> list[str]:
        if not vertex_id:
            return []
        raw_id = str(vertex_id).strip()
        # Some proxies/logs hand the id back in its JSON-quoted or URL-encoded
        # representation. Normalize it once before applying HugeGraph's type
        # syntax; otherwise `%22` becomes `%2522` and the server sees percent
        # text instead of a String id.
        for _ in range(2):
            lowered = raw_id.lower()
            if not (
                (lowered.startswith("%22") and lowered.endswith("%22"))
                or (lowered.startswith("%2522") and lowered.endswith("%2522"))
            ):
                break
            decoded = urllib.parse.unquote(raw_id)
            if decoded == raw_id:
                break
            raw_id = decoded
        if raw_id.startswith('"') and raw_id.endswith('"'):
            try:
                decoded_json = json.loads(raw_id)
                if isinstance(decoded_json, str):
                    raw_id = decoded_json
            except Exception:
                raw_id = raw_id[1:-1]

        # LogSysNode uses PRIMARY_KEY, therefore its REST id is a JSON String
        # enclosed in quotes. Encode that typed value exactly once as required
        # by HugeGraph. For ids containing '/', keep only the slash protected
        # for one extra routing decode; never double-encode the whole id.
        canonical = urllib.parse.quote(json.dumps(raw_id, ensure_ascii=False), safe="")
        slash_protected = canonical.replace("%2F", "%252F").replace("%2f", "%252F")
        candidates = [slash_protected, canonical]
        deduped: list[str] = []
        for item in candidates:
            if item not in deduped:
                deduped.append(item)
        return deduped

    def update_node_by_id(
        self,
        vertex_id: str,
        name: str,
        layer: str = "Component层",
        kind: str = "Component",
        description: str = "",
        source_file: str = "",
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = self._node_payload(name, layer, kind, description, source_file, meta)
        # Do not try to update the primary key name when editing an existing id.
        payload["properties"].pop(self.pk_name, None)
        last_error: Exception | None = None
        for encoded in self._encoded_id_candidates(vertex_id):
            try:
                return self._request("PUT", f"graph/vertices/{encoded}", params={"action": "append"}, json_body=payload, expected=(200, 201, 202))
            except Exception as exc:  # noqa: BLE001
                last_error = exc
        if last_error:
            raise last_error
        raise HugeGraphRestError("节点 id 为空，无法更新。")

    def update_node_by_name(self, original_name: str, data: dict[str, Any]) -> dict[str, Any]:
        self.ensure_schema()
        existing = self.find_node_by_name(original_name)
        if not existing:
            raise HugeGraphRestError(f"未找到节点: {original_name}")
        props = existing.get("properties", {}) or {}
        name = str(data.get("name") or props.get(self.pk_name) or original_name)
        if name != original_name:
            # HugeGraph primary key cannot be changed in place. Create the new node,
            # then keep the old node unless the caller explicitly deletes it.
            return self.upsert_node(
                name=name,
                layer=str(data.get("layer") if data.get("layer") is not None else props.get(self.pk_layer) or "Component层"),
                kind=str(data.get("kind") if data.get("kind") is not None else props.get(self.pk_kind) or "Component"),
                description=str(data.get("description") if data.get("description") is not None else props.get(self.pk_desc) or ""),
                source_file=str(data.get("source_file") if data.get("source_file") is not None else props.get(self.pk_source_file) or "manual"),
                meta=data.get("meta") if data.get("meta") is not None else _json_dict(props.get(self.pk_meta)),
            )
        return self.update_node_by_id(
            str(existing.get("id") or ""),
            name=name,
            layer=str(data.get("layer") if data.get("layer") is not None else props.get(self.pk_layer) or "Component层"),
            kind=str(data.get("kind") if data.get("kind") is not None else props.get(self.pk_kind) or "Component"),
            description=str(data.get("description") if data.get("description") is not None else props.get(self.pk_desc) or ""),
            source_file=str(data.get("source_file") if data.get("source_file") is not None else props.get(self.pk_source_file) or "manual"),
            meta=data.get("meta") if data.get("meta") is not None else _json_dict(props.get(self.pk_meta)),
        )

    def delete_node_by_name(self, name: str) -> bool:
        return self.batch_delete_nodes([name])["deleted_nodes"] > 0

    def find_node_by_name(self, name: str) -> dict[str, Any] | None:
        vertices = self.list_vertices(limit=10000)
        # A scoped name such as project::p1::order must never fall back to the
        # display name "order", otherwise it can resolve project::p2::order.
        scoped_name = name.startswith("project::")
        for vertex in vertices:
            v_id = str(vertex.get("id") or "")
            props = vertex.get("properties") or {}
            v_name = str(props.get(self.pk_name) or "")
            if name in (v_name, v_id):
                return vertex
        if scoped_name:
            return None

        for vertex in vertices:
            props = vertex.get("properties") or {}
            meta = _json_dict(props.get(self.pk_meta))
            display_name = str(meta.get("display_name") or "")
            if name and name == display_name:
                return vertex
        return None

    def _relation_key(self, source_id: str, target_id: str, relation_type: str) -> str:
        return f"{source_id}|{relation_type or 'CALLS'}|{target_id}"

    def add_edge(
        self,
        source_id: str,
        target_id: str,
        relation_type: str = "CALLS",
        description: str = "",
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.ensure_schema()
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
                self.pk_relation_meta: _json_text(meta or {}),
            },
        }
        try:
            return self._request("POST", "graph/edges", json_body=payload, expected=(200, 201, 202))
        except HugeGraphRestError as exc:
            msg = str(exc).lower()
            if "exist" in msg or "duplicate" in msg or "already" in msg:
                return {"id": "exists", "label": self.edge_label, "properties": payload["properties"]}
            raise

    def add_edge_by_names(
        self,
        source_name: str,
        target_name: str,
        relation_type: str = "CALLS",
        description: str = "",
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.ensure_schema()
        source = self.find_node_by_name(source_name)
        target = self.find_node_by_name(target_name)
        if not source:
            source = self.upsert_node(source_name, "Component层", "Component", "自动创建的关系端点", "manual")
        if not target:
            target = self.upsert_node(target_name, "Component层", "Component", "自动创建的关系端点", "manual")
        return self.add_edge(str(source.get("id") or ""), str(target.get("id") or ""), relation_type, description, meta)

    def add_edges_by_names_bulk(self, edges: list[dict[str, Any]]) -> int:
        self.ensure_schema()
        vertices = self.list_vertices(limit=100000)
        name_to_id = {
            str((vertex.get("properties") or {}).get(self.pk_name) or ""): str(vertex.get("id") or "")
            for vertex in vertices
        }
        count = 0
        for edge in edges:
            source_name = str(edge.get("source") or "")
            target_name = str(edge.get("target") or "")
            if not source_name or not target_name or source_name == target_name:
                continue
            source_id = name_to_id.get(source_name)
            if not source_id:
                source = self.upsert_node(source_name, "Component层", "Component", "自动创建的关系端点", "manual")
                source_id = str(source.get("id") or "")
                name_to_id[source_name] = source_id
            target_id = name_to_id.get(target_name)
            if not target_id:
                target = self.upsert_node(target_name, "Component层", "Component", "自动创建的关系端点", "manual")
                target_id = str(target.get("id") or "")
                name_to_id[target_name] = target_id
            self.add_edge(
                source_id,
                target_id,
                str(edge.get("type") or "CALLS"),
                str(edge.get("description") or ""),
                edge.get("meta") if isinstance(edge.get("meta"), dict) else {},
            )
            count += 1
        return count

    def delete_edge_by_tuple(self, source_name: str, target_name: str, relation_type: str = "CALLS") -> bool:
        return self.batch_delete_edges([
            {"source": source_name, "target": target_name, "type": relation_type}
        ])["deleted_edges"] > 0

    def delete_edge_by_id(self, edge_id: str) -> bool:
        if not edge_id:
            return False
        encoded = urllib.parse.quote(edge_id, safe="")
        try:
            self._request("DELETE", f"graph/edges/{encoded}", expected=(200, 202, 204))
            return True
        except HugeGraphRestError as exc:
            if exc.status_code == 404:
                return False
            raise

    def delete_nodes_by_names(self, names: list[str]) -> int:
        return self.batch_delete_nodes(names)["deleted_nodes"]

    def _delete_snapshot(self, entity: str, label: str) -> list[dict[str, Any]]:
        """Read one complete snapshot, not one full scan per target/edge endpoint.

        HugeGraph paging must not be combined with label filters on older
        servers. Filter the label locally and keep paging until its cursor ends.
        Finish the read before deleting so mutations cannot invalidate cursors.
        """
        records: dict[str, dict[str, Any]] = {}
        page = ""
        seen_pages: set[str] = set()
        while True:
            data = self._request("GET", f"graph/{entity}", params={"page": page, "limit": 2000})
            if not isinstance(data, dict) or not isinstance(data.get(entity), list) or "page" not in data:
                raise HugeGraphRestError("HugeGraph 未返回完整分页信息，已停止删除，避免使用截断的图谱数据")
            for item in data[entity]:
                if item.get("label") == label and item.get("id") is not None:
                    records[str(item["id"])] = item
            next_page = data.get("page")
            if not next_page:
                return list(records.values())
            page = str(next_page)
            if page in seen_pages:
                raise HugeGraphRestError("HugeGraph 返回重复分页游标，已停止删除")
            seen_pages.add(page)

    def _delete_vertex_by_id(self, vertex_id: str) -> bool:
        last_error: HugeGraphRestError | None = None
        for encoded in self._encoded_id_candidates(vertex_id):
            try:
                self._request("DELETE", f"graph/vertices/{encoded}", params={"label": self.node_label}, expected=(200, 202, 204))
                return True
            except HugeGraphRestError as exc:
                # Retry only URL-format/not-found variants, never a timeout or
                # server error: the previous delete may already have committed.
                if exc.status_code not in (400, 404):
                    raise
                last_error = exc
        if last_error and last_error.status_code != 404:
            raise last_error
        return False

    def batch_delete_nodes(self, names: list[str]) -> dict[str, int]:
        self.ensure_schema()
        target_names = {str(name or "") for name in names if str(name or "")}
        if not target_names:
            return {"deleted_nodes": 0, "deleted_edges": 0, "not_found_nodes": 0}
        vertices = self._delete_snapshot("vertices", self.node_label)
        targets = [
            vertex
            for vertex in vertices
            if str((vertex.get("properties") or {}).get(self.pk_name) or "") in target_names
        ]
        target_ids = {str(vertex.get("id") or "") for vertex in targets if str(vertex.get("id") or "")}
        if not target_ids:
            return {"deleted_nodes": 0, "deleted_edges": 0, "not_found_nodes": len(target_names)}
        adjacent = []
        for edge in self._delete_snapshot("edges", self.edge_label):
            if str(edge.get("outV") or "") in target_ids or str(edge.get("inV") or "") in target_ids:
                adjacent.append(edge)
        deleted_edges = sum(self.delete_edge_by_id(str(edge["id"])) for edge in adjacent)
        deleted_nodes = sum(self._delete_vertex_by_id(vertex_id) for vertex_id in sorted(target_ids))
        return {
            "deleted_nodes": deleted_nodes,
            "deleted_edges": deleted_edges,
            "not_found_nodes": len(target_names) - deleted_nodes,
        }

    def batch_delete_edges(self, edges: list[dict[str, str]]) -> dict[str, int]:
        self.ensure_schema()
        requested = {
            (item["source"], item["target"], str(item.get("type") or "CALLS"))
            for item in edges if item.get("source") and item.get("target")
        }
        if not requested:
            return {"deleted_edges": 0, "not_found_edges": 0}
        vertices = self._delete_snapshot("vertices", self.node_label)
        id_to_name = {
            str(vertex["id"]): str((vertex.get("properties") or {}).get(self.pk_name) or "")
            for vertex in vertices
        }
        matched = set()
        targets = []
        for edge in self._delete_snapshot("edges", self.edge_label):
            key = (
                id_to_name.get(str(edge.get("outV"))),
                id_to_name.get(str(edge.get("inV"))),
                str((edge.get("properties") or {}).get(self.pk_relation_type) or "CALLS"),
            )
            if key in requested:
                targets.append(edge)
                matched.add(key)
        deleted = sum(self.delete_edge_by_id(str(edge["id"])) for edge in targets)
        return {"deleted_edges": deleted, "not_found_edges": len(requested - matched)}

    def _vertex_name_by_id(self, vertex_id: str) -> str:
        for vertex in self.list_vertices(limit=10000):
            if str(vertex.get("id") or "") == vertex_id:
                return str((vertex.get("properties") or {}).get(self.pk_name) or vertex_id)
        return vertex_id

    def list_vertices(self, limit: int = 800) -> list[dict[str, Any]]:
        try:
            data = self._request("GET", "graph/vertices", params={"label": self.node_label, "limit": limit}, expected=(200,))
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
            data = self._request("GET", "graph/edges", params={"label": self.edge_label, "limit": limit}, expected=(200,))
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
                    source_file=str(props.get(self.pk_source_file) or ""),
                    meta=_json_dict(props.get(self.pk_meta)),
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
                    meta=_json_dict(props.get(self.pk_relation_meta)),
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
            if self.delete_edge_by_id(edge_id):
                edge_count += 1

        vertex_count = 0
        for vertex in self.list_vertices(limit=10000):
            vertex_id = str(vertex.get("id") or "")
            if not vertex_id:
                continue
            for encoded in self._encoded_id_candidates(vertex_id):
                try:
                    self._request("DELETE", f"graph/vertices/{encoded}", params={"label": self.node_label}, expected=(200, 202, 204))
                    vertex_count += 1
                    break
                except HugeGraphRestError:
                    continue
        return {"deleted_edges": edge_count, "deleted_vertices": vertex_count}
