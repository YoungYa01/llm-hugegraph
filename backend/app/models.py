from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ExtractedNode(BaseModel):
    name: str
    layer: str = "Component层"
    kind: str = "Component"
    description: str = ""
    source_file: str = ""
    meta: dict[str, Any] = Field(default_factory=dict)


class ExtractedCall(BaseModel):
    source: str
    target: str
    type: str = "CALLS"
    description: str = ""
    meta: dict[str, Any] = Field(default_factory=dict)


class ExtractedGraph(BaseModel):
    services: list[ExtractedNode] = Field(default_factory=list)
    calls: list[ExtractedCall] = Field(default_factory=list)


class GraphNode(BaseModel):
    id: str
    name: str
    layer: str = "Component层"
    kind: str = "Component"
    description: str = ""
    source_file: str = ""
    meta: dict[str, Any] = Field(default_factory=dict)


class GraphEdge(BaseModel):
    id: str = ""
    source: str
    target: str
    type: str = "CALLS"
    description: str = ""
    meta: dict[str, Any] = Field(default_factory=dict)


class GraphResponse(BaseModel):
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class NodeUpsertRequest(BaseModel):
    name: str
    layer: str = "Component层"
    kind: str = "Component"
    description: str = ""
    source_file: str = "manual"
    meta: dict[str, Any] = Field(default_factory=dict)


class NodeUpdateRequest(BaseModel):
    name: str | None = None
    layer: str | None = None
    kind: str | None = None
    description: str | None = None
    source_file: str | None = None
    meta: dict[str, Any] | None = None


class EdgeUpsertRequest(BaseModel):
    source: str
    target: str
    type: str = "CALLS"
    description: str = ""
    meta: dict[str, Any] = Field(default_factory=dict)


class EdgeDeleteRequest(BaseModel):
    source: str
    target: str
    type: str = "CALLS"
