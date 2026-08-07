from __future__ import annotations

import json
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any

from .hugegraph_client import HugeGraphRestClient
from .scoped_graph import DYNAMIC_KINDS, ProjectScopedGraphClient
from .system_db import SystemDatabase

GRAPH_SCAN_NODE_LIMIT = 50_000
GRAPH_SCAN_EDGE_LIMIT = 100_000


def _json_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except (TypeError, ValueError, json.JSONDecodeError):
            return {}
    return {}


def _project_and_display(name: str, meta: dict[str, Any]) -> tuple[str, str]:
    project_id = str(meta.get("project_id") or "")
    display = str(meta.get("display_name") or "")
    if name.startswith("project::"):
        parts = name.split("::", 2)
        if len(parts) == 3:
            project_id = project_id or parts[1]
            display = display or parts[2]
    return project_id, display or name


def _public_operation(row: dict[str, Any]) -> dict[str, Any]:
    item = dict(row)
    for source, target in (("preview_json", "preview"), ("result_json", "result")):
        try:
            value = json.loads(str(item.pop(source, "{}") or "{}"))
        except (TypeError, ValueError, json.JSONDecodeError):
            value = {}
        item[target] = value if isinstance(value, dict) else {}
    return item


def _orphan_diagnosis(node: dict[str, Any]) -> tuple[str, str, str]:
    """Return a conservative reason, suggestion and deletion risk."""
    kind = str(node.get("kind") or "")
    source_file = str(node.get("source_file") or "").lower()
    meta = node.get("meta") if isinstance(node.get("meta"), dict) else {}
    if not node.get("project_id"):
        return (
            "节点缺少项目命名空间或 project_id，无法与项目内关系正确匹配",
            "先核对节点来源和项目归属，确认无业务引用后再处理",
            "high",
        )
    if kind in DYNAMIC_KINDS:
        return (
            "日志/RCA 动态节点没有关联边，可能由分析写入中断或关联批次已被部分清理造成",
            "核对对应日志批次；若批次已失效，可删除该节点",
            "low",
        )
    if source_file == "manual" or bool(meta.get("manual")):
        return (
            "节点由人工创建，但尚未建立关系，或原有关系已被删除",
            "先在系统架构图谱补充关系；确认属于误建数据后再删除",
            "medium",
        )
    if source_file:
        return (
            "架构导入只生成了节点，可能未抽取到关系、关系端点名称不一致或关系写入失败",
            "检查来源文档中的上下游描述及导入记录，优先补关系而不是直接删除",
            "medium",
        )
    return (
        "节点没有来源文件和任何有效关系，可能是历史残留或关系已被清理",
        "核对业务组件是否仍存在，确认无引用后再删除",
        "high",
    )


class GraphAdminService:
    """Read-only inspection plus narrowly scoped, audited graph maintenance."""

    def __init__(
        self,
        database: SystemDatabase,
        client: HugeGraphRestClient | None = None,
    ) -> None:
        self.database = database
        self.client = client or HugeGraphRestClient()

    def status(self) -> dict[str, Any]:
        started = time.perf_counter()
        ping = self.client.ping()
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
        schema_text = json.dumps(ping.get("base_checks") or [], ensure_ascii=False)
        node_ready = self.client.node_label in schema_text
        edge_ready = self.client.edge_label in schema_text
        return {
            "status": ping.get("status") or "failed",
            "latency_ms": elapsed_ms,
            "host": self.client.host,
            "port": self.client.port,
            "graphspace": self.client.graphspace,
            "graph": self.client.graph,
            "selected_base_url": ping.get("selected_base_url"),
            "schema": {
                "ready": node_ready and edge_ready,
                "node_label": self.client.node_label,
                "node_label_ready": node_ready,
                "edge_label": self.client.edge_label,
                "edge_label_ready": edge_ready,
            },
            "error": self._ping_error(ping),
        }

    @staticmethod
    def _ping_error(ping: dict[str, Any]) -> str:
        if ping.get("status") == "ok":
            return ""
        if ping.get("versions_error"):
            return str(ping["versions_error"])
        for item in ping.get("base_checks") or []:
            if item.get("error"):
                return str(item["error"])
        return "HugeGraph 连接或 Schema 检查失败"

    def snapshot(self) -> dict[str, Any]:
        vertices = self.client.list_vertices(limit=GRAPH_SCAN_NODE_LIMIT)
        raw_edges = self.client.list_edges(limit=GRAPH_SCAN_EDGE_LIMIT)
        projects = self.database.query_all(
            "SELECT id, name, status, owner_id FROM projects ORDER BY created_at ASC"
        )
        project_map = {str(item["id"]): item for item in projects}

        nodes: list[dict[str, Any]] = []
        by_id: dict[str, dict[str, Any]] = {}
        for vertex in vertices:
            props = vertex.get("properties") or {}
            vertex_id = str(vertex.get("id") or "")
            internal_name = str(props.get(self.client.pk_name) or vertex_id)
            meta = _json_dict(props.get(self.client.pk_meta))
            project_id, display_name = _project_and_display(internal_name, meta)
            node = {
                "id": vertex_id,
                "internal_name": internal_name,
                "name": display_name,
                "project_id": project_id,
                "project_name": str(
                    (project_map.get(project_id) or {}).get("name") or "未归属项目"
                ),
                "kind": str(props.get(self.client.pk_kind) or "Component"),
                "layer": str(props.get(self.client.pk_layer) or "Component层"),
                "description": str(props.get(self.client.pk_desc) or ""),
                "source_file": str(props.get(self.client.pk_source_file) or ""),
                "meta": meta,
            }
            nodes.append(node)
            by_id[vertex_id] = node

        edges: list[dict[str, Any]] = []
        for raw in raw_edges:
            props = raw.get("properties") or {}
            source_id = str(raw.get("outV") or "")
            target_id = str(raw.get("inV") or "")
            source = by_id.get(source_id)
            target = by_id.get(target_id)
            meta = _json_dict(props.get(self.client.pk_relation_meta))
            project_id = str(meta.get("project_id") or "")
            if (
                not project_id
                and source
                and target
                and source["project_id"] == target["project_id"]
            ):
                project_id = str(source["project_id"])
            edges.append(
                {
                    "id": str(raw.get("id") or ""),
                    "source_id": source_id,
                    "target_id": target_id,
                    "source": str((source or {}).get("name") or source_id),
                    "target": str((target or {}).get("name") or target_id),
                    "source_internal": str(
                        (source or {}).get("internal_name") or source_id
                    ),
                    "target_internal": str(
                        (target or {}).get("internal_name") or target_id
                    ),
                    "project_id": project_id,
                    "source_project_id": str((source or {}).get("project_id") or ""),
                    "target_project_id": str((target or {}).get("project_id") or ""),
                    "project_name": str(
                        (project_map.get(project_id) or {}).get("name") or "未归属项目"
                    ),
                    "relation": str(props.get(self.client.pk_relation_type) or "CALLS"),
                    "description": str(props.get(self.client.pk_relation_desc) or ""),
                    "meta": meta,
                    "valid": bool(source and target),
                }
            )
        return {
            "nodes": nodes,
            "edges": edges,
            "projects": projects,
            "scan": {
                "node_limit": GRAPH_SCAN_NODE_LIMIT,
                "edge_limit": GRAPH_SCAN_EDGE_LIMIT,
                "nodes_truncated": len(vertices) >= GRAPH_SCAN_NODE_LIMIT,
                "edges_truncated": len(raw_edges) >= GRAPH_SCAN_EDGE_LIMIT,
            },
        }

    def overview(self) -> dict[str, Any]:
        snapshot = self.snapshot()
        nodes = snapshot["nodes"]
        edges = snapshot["edges"]
        node_types = Counter(item["kind"] for item in nodes)
        edge_types = Counter(item["relation"] for item in edges)
        per_project: dict[str, dict[str, Any]] = {}
        for project in snapshot["projects"]:
            per_project[str(project["id"])] = {
                **project,
                "nodes": 0,
                "edges": 0,
                "architecture_nodes": 0,
                "dynamic_nodes": 0,
            }
        for node in nodes:
            target = per_project.get(node["project_id"])
            if target:
                target["nodes"] += 1
                bucket = (
                    "dynamic_nodes"
                    if node["kind"] in DYNAMIC_KINDS
                    else "architecture_nodes"
                )
                target[bucket] += 1
        for edge in edges:
            target = per_project.get(edge["project_id"])
            if target:
                target["edges"] += 1
        return {
            "totals": {
                "nodes": len(nodes),
                "edges": len(edges),
                "architecture_nodes": sum(
                    item["kind"] not in DYNAMIC_KINDS for item in nodes
                ),
                "dynamic_nodes": sum(item["kind"] in DYNAMIC_KINDS for item in nodes),
                "unscoped_nodes": sum(not item["project_id"] for item in nodes),
                "invalid_edges": sum(not item["valid"] for item in edges),
            },
            "node_types": [
                {"name": name, "count": count}
                for name, count in node_types.most_common()
            ],
            "edge_types": [
                {"name": name, "count": count}
                for name, count in edge_types.most_common()
            ],
            "projects": list(per_project.values()),
            "scan": snapshot["scan"],
        }

    def data(
        self,
        *,
        entity: str,
        page: int,
        page_size: int,
        project_id: str = "",
        category: str = "",
        query: str = "",
    ) -> dict[str, Any]:
        snapshot = self.snapshot()
        items = snapshot["nodes"] if entity == "nodes" else snapshot["edges"]
        query_lower = query.strip().lower()
        filtered = []
        for item in items:
            if project_id and item.get("project_id") != project_id:
                continue
            item_category = (
                item.get("kind") if entity == "nodes" else item.get("relation")
            )
            if category and item_category != category:
                continue
            if query_lower:
                searchable = " ".join(
                    str(item.get(key) or "")
                    for key in (
                        "name",
                        "source",
                        "target",
                        "description",
                        "source_file",
                        "project_name",
                    )
                ).lower()
                if query_lower not in searchable:
                    continue
            filtered.append(item)
        total = len(filtered)
        start = (page - 1) * page_size
        return {
            "entity": entity,
            "items": filtered[start : start + page_size],
            "page": page,
            "page_size": page_size,
            "total": total,
            "pages": max(1, (total + page_size - 1) // page_size),
            "scan": snapshot["scan"],
        }

    def quality(self, project_id: str = "") -> dict[str, Any]:
        snapshot = self.snapshot()
        nodes = [
            item
            for item in snapshot["nodes"]
            if not project_id or item["project_id"] == project_id
        ]
        node_ids = {item["id"] for item in nodes}
        edges = [
            item
            for item in snapshot["edges"]
            if not project_id
            or item["project_id"] == project_id
            or item["source_id"] in node_ids
            or item["target_id"] in node_ids
        ]
        connected = {
            endpoint
            for edge in edges
            for endpoint in (edge["source_id"], edge["target_id"])
            if edge["valid"]
        }
        orphan_nodes = []
        for item in nodes:
            if item["id"] in connected:
                continue
            reason, suggestion, deletion_risk = _orphan_diagnosis(item)
            orphan_nodes.append(
                {
                    **item,
                    "likely_reason": reason,
                    "suggestion": suggestion,
                    "deletion_risk": deletion_risk,
                }
            )
        invalid_edges = [item for item in edges if not item["valid"]]
        cross_project_edges = [
            item
            for item in edges
            if item["source_project_id"]
            and item["target_project_id"]
            and item["source_project_id"] != item["target_project_id"]
        ]
        known_project_ids = {str(item["id"]) for item in snapshot["projects"]}
        unknown_project_nodes = [
            item
            for item in nodes
            if item["project_id"] and item["project_id"] not in known_project_ids
        ]
        unscoped_nodes = []
        for item in nodes:
            if item["project_id"]:
                continue
            reason, suggestion, deletion_risk = _orphan_diagnosis(item)
            unscoped_nodes.append(
                {
                    **item,
                    "likely_reason": reason,
                    "suggestion": suggestion,
                    "deletion_risk": deletion_risk,
                }
            )
        groups: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
        for edge in edges:
            groups[(edge["source_id"], edge["target_id"], edge["relation"])].append(
                edge
            )
        duplicate_groups = [
            {
                "source": values[0]["source"],
                "target": values[0]["target"],
                "relation": values[0]["relation"],
                "count": len(values),
                "edge_ids": [item["id"] for item in values],
            }
            for values in groups.values()
            if len(values) > 1
        ]
        return {
            "summary": {
                "orphan_nodes": len(orphan_nodes),
                "invalid_edges": len(invalid_edges),
                "duplicate_edge_groups": len(duplicate_groups),
                "unscoped_nodes": len(unscoped_nodes),
                "cross_project_edges": len(cross_project_edges),
                "unknown_project_nodes": len(unknown_project_nodes),
            },
            "orphan_nodes": orphan_nodes[:200],
            "invalid_edges": invalid_edges[:200],
            "duplicate_edges": duplicate_groups[:200],
            "cross_project_edges": cross_project_edges[:200],
            "unknown_project_nodes": unknown_project_nodes[:200],
            "unscoped_nodes": unscoped_nodes[:200],
            "sample_limit": 200,
            "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "scan": snapshot["scan"],
        }

    @staticmethod
    def _project_orphan_nodes(
        snapshot: dict[str, Any], project_id: str
    ) -> list[dict[str, Any]]:
        nodes = [node for node in snapshot["nodes"] if node["project_id"] == project_id]
        node_ids = {node["id"] for node in nodes}
        connected = {
            endpoint
            for edge in snapshot["edges"]
            if edge["valid"]
            and (
                edge["project_id"] == project_id
                or edge["source_id"] in node_ids
                or edge["target_id"] in node_ids
            )
            for endpoint in (edge["source_id"], edge["target_id"])
        }
        return [node for node in nodes if node["id"] not in connected]

    def project_export(self, project_id: str) -> dict[str, Any]:
        project = self.database.get_project(project_id)
        if not project:
            raise ValueError("项目不存在")
        graph = ProjectScopedGraphClient(project_id, self.client).read_graph(
            limit=GRAPH_SCAN_NODE_LIMIT
        )
        return {
            "format": "logscope-project-graph-v1",
            "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "project": {
                key: project.get(key) for key in ("id", "name", "description", "status")
            },
            "nodes": [
                node.model_dump() if hasattr(node, "model_dump") else node.dict()
                for node in graph.nodes
            ],
            "edges": [
                edge.model_dump() if hasattr(edge, "model_dump") else edge.dict()
                for edge in graph.edges
            ],
            "warnings": graph.warnings,
        }

    def preview_operation(
        self,
        *,
        actor_id: str,
        action: str,
        project_id: str,
        target_id: str = "",
        target_names: list[str] | None = None,
    ) -> dict[str, Any]:
        project = self.database.get_project(project_id)
        if not project:
            raise ValueError("项目不存在")
        snapshot = self.snapshot()
        project_nodes = [
            node for node in snapshot["nodes"] if node["project_id"] == project_id
        ]
        project_node_ids = {node["id"] for node in project_nodes}
        project_edges = [
            edge
            for edge in snapshot["edges"]
            if edge["project_id"] == project_id
            or edge["source_id"] in project_node_ids
            or edge["target_id"] in project_node_ids
        ]
        if action == "clear_project":
            affected_nodes = project_nodes
            affected_edges = project_edges
            confirmation = str(project["name"])
            description = "清空该项目在 HugeGraph 中的全部架构、日志与 RCA 图数据"
        elif action == "cleanup_batch":
            batch = self.database.get_log_batch(target_id)
            if not batch or str(batch.get("project_id")) != project_id:
                raise ValueError("日志批次不存在或不属于该项目")
            token = f":{target_id}:"
            affected_nodes = [
                node
                for node in project_nodes
                if node["kind"] in DYNAMIC_KINDS and token in node["name"]
            ]
            affected_ids = {node["id"] for node in affected_nodes}
            affected_edges = [
                edge
                for edge in project_edges
                if edge["source_id"] in affected_ids
                or edge["target_id"] in affected_ids
            ]
            confirmation = str(target_id)
            description = f"清理日志批次 {batch['filename']} 产生的动态图谱数据"
        elif action == "delete_orphan_nodes":
            requested_names = list(
                dict.fromkeys(
                    str(name).strip()
                    for name in (target_names or [])
                    if str(name).strip()
                )
            )
            if not requested_names:
                raise ValueError("请至少选择一个孤立节点")
            if len(requested_names) > 200:
                raise ValueError("单次最多删除 200 个孤立节点")
            current_orphans = {
                node["name"]: node
                for node in self._project_orphan_nodes(snapshot, project_id)
            }
            invalid_names = [
                name for name in requested_names if name not in current_orphans
            ]
            if invalid_names:
                raise ValueError("所选节点已不再是孤立节点，请重新执行质量检查")
            affected_nodes = [current_orphans[name] for name in requested_names]
            affected_ids = {node["id"] for node in affected_nodes}
            affected_edges = [
                edge
                for edge in project_edges
                if edge["source_id"] in affected_ids
                or edge["target_id"] in affected_ids
            ]
            confirmation = f"删除{len(affected_nodes)}个孤立节点"
            description = (
                f"删除项目 {project['name']} 中选中的 {len(affected_nodes)} 个孤立节点"
            )
            target_id = f"selected:{len(affected_nodes)}"
        else:
            raise ValueError("不支持的图谱操作")
        preview = {
            "action": action,
            "description": description,
            "project_id": project_id,
            "project_name": project["name"],
            "target_id": target_id,
            "affected_nodes": len(affected_nodes),
            "affected_edges": len(affected_edges),
            "node_samples": [node["name"] for node in affected_nodes[:10]],
            "target_names": [node["name"] for node in affected_nodes]
            if action == "delete_orphan_nodes"
            else [],
            "irreversible": True,
        }
        row = self.database.create_graph_admin_operation(
            actor_id=actor_id,
            action=action,
            project_id=project_id,
            target_id=target_id,
            confirmation_text=confirmation,
            preview=preview,
        )
        return _public_operation(row)

    def execute_operation(
        self,
        *,
        operation_id: str,
        actor_id: str,
        confirmation_text: str,
    ) -> dict[str, Any]:
        row = self.database.get_graph_admin_operation(operation_id)
        if not row:
            raise ValueError("操作预览不存在")
        if row.get("status") != "previewed":
            raise ValueError("该操作已执行或已失效，请重新预览")
        if str(row.get("actor_id")) != actor_id:
            raise PermissionError("只能执行由当前管理员创建的操作预览")
        if confirmation_text.strip() != str(row.get("confirmation_text") or ""):
            raise ValueError("二次确认文本不匹配")
        created_at = datetime.fromisoformat(str(row["created_at"]))
        if (datetime.now(timezone.utc) - created_at).total_seconds() > 600:
            raise ValueError("操作预览已超过 10 分钟，请重新预览")

        preview = _json_dict(row.get("preview_json"))
        orphan_names: list[str] = []
        if row["action"] == "delete_orphan_nodes":
            orphan_names = [
                str(name) for name in preview.get("target_names") or [] if str(name)
            ]
            current_orphan_names = {
                node["name"]
                for node in self._project_orphan_nodes(
                    self.snapshot(), str(row["project_id"])
                )
            }
            if not orphan_names or any(
                name not in current_orphan_names for name in orphan_names
            ):
                raise ValueError("孤立节点状态已经变化，请重新检查并生成预览")

        if not self.database.start_graph_admin_operation(operation_id):
            raise ValueError("该操作已被其他请求执行，请刷新审计记录")
        scoped = ProjectScopedGraphClient(str(row["project_id"]), self.client)
        try:
            if row["action"] == "clear_project":
                result = scoped.clear_project_graph()
            elif row["action"] == "cleanup_batch":
                result = scoped.delete_incident_batch(str(row["target_id"]))
            elif row["action"] == "delete_orphan_nodes":
                result = {
                    "requested_vertices": len(orphan_names),
                    "deleted_vertices": scoped.delete_nodes_by_names(orphan_names),
                }
            else:
                raise ValueError("不支持的图谱操作")
            self.database.finish_graph_admin_operation(operation_id, result=result)
        except Exception as exc:
            self.database.finish_graph_admin_operation(
                operation_id, error_message=str(exc)
            )
            raise
        return _public_operation(
            self.database.get_graph_admin_operation(operation_id) or {}
        )

    def operations(self, limit: int = 100) -> list[dict[str, Any]]:
        return [
            _public_operation(item)
            for item in self.database.list_graph_admin_operations(limit)
        ]
