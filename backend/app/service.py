from __future__ import annotations

from .analyzer import LLMAnalyzer, split_text
from .config import get_settings
from .hugegraph_client import HugeGraphRestClient
from .models import ExtractedGraph, ExtractedNode, ExtractedCall


class GraphBuilderService:
    """Business service: LLM extraction -> HugeGraph REST write -> graph read model."""

    def __init__(self) -> None:
        self.settings = get_settings()
        self.db = HugeGraphRestClient()
        self.analyzer = LLMAnalyzer()

    def initialize_system(self) -> list[str]:
        return self.db.ensure_schema()

    def build_ontology_graph(self, doc_text: str, source_file: str = "") -> tuple[dict, list[str]]:
        execution_logs: list[str] = []
        execution_logs.extend(self.initialize_system())

        chunks = split_text(doc_text, self.settings.llm_chunk_chars)
        if not chunks:
            return {"services": [], "calls": []}, [*execution_logs, "输入文件为空，未写入图谱。"]

        merged = ExtractedGraph()
        for index, chunk in enumerate(chunks, start=1):
            execution_logs.append(f"LLM 抽取分片 {index}/{len(chunks)}，字符数={len(chunk)}")
            data = self.analyzer.analyze_architecture(chunk)
            execution_logs.append(f"抽取模式: {self.analyzer.last_mode}")
            execution_logs.extend(self.analyzer.last_logs)
            part = ExtractedGraph.model_validate(data)
            merged = self._merge_graphs(merged, part)

        # Normalize relationships again; ensure all endpoints are nodes.
        merged = self._complete_missing_nodes(merged)

        real_id_map: dict[str, str] = {}
        for node in merged.services:
            res = self.db.upsert_node(
                name=node.name,
                layer=node.layer,
                kind=node.kind,
                description=node.description,
                source_file=source_file,
            )
            real_id = str(res.get("id") or "")
            if real_id:
                real_id_map[node.name] = real_id
                execution_logs.append(f"写入/获取节点: {node.name} -> {real_id}")
            else:
                execution_logs.append(f"警告：节点 {node.name} 写入后未返回 id。返回={res}")

        seen_edges: set[tuple[str, str, str]] = set()
        for call in merged.calls:
            key = (call.source, call.target, call.type)
            if key in seen_edges:
                continue
            seen_edges.add(key)
            out_id = real_id_map.get(call.source)
            in_id = real_id_map.get(call.target)
            if not out_id or not in_id:
                execution_logs.append(f"跳过关系，未找到端点真实 ID: {call.source} -[{call.type}]-> {call.target}")
                continue
            res = self.db.add_edge(out_id, in_id, call.type, call.description)
            execution_logs.append(f"写入关系: {call.source} -[{call.type}]-> {call.target} -> {res.get('id', '')}")

        return merged.model_dump(), execution_logs

    def _merge_graphs(self, left: ExtractedGraph, right: ExtractedGraph) -> ExtractedGraph:
        nodes: dict[str, ExtractedNode] = {n.name: n for n in left.services}
        for n in right.services:
            if n.name not in nodes:
                nodes[n.name] = n
            else:
                old = nodes[n.name]
                nodes[n.name] = ExtractedNode(
                    name=old.name,
                    layer=old.layer if old.layer != "Component层" else n.layer,
                    kind=old.kind if old.kind != "Component" else n.kind,
                    description=old.description or n.description,
                )

        calls: dict[tuple[str, str, str], ExtractedCall] = {(c.source, c.target, c.type): c for c in left.calls}
        for c in right.calls:
            calls[(c.source, c.target, c.type)] = c
        return ExtractedGraph(services=list(nodes.values()), calls=list(calls.values()))

    def _complete_missing_nodes(self, graph: ExtractedGraph) -> ExtractedGraph:
        nodes: dict[str, ExtractedNode] = {n.name: n for n in graph.services}
        for call in graph.calls:
            if call.source not in nodes:
                nodes[call.source] = ExtractedNode(name=call.source, layer="Component层", kind="Component")
            if call.target not in nodes:
                nodes[call.target] = ExtractedNode(name=call.target, layer="Component层", kind="Component")
        return ExtractedGraph(services=list(nodes.values()), calls=graph.calls)
