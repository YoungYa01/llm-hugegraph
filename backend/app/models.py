from __future__ import annotations

from pydantic import BaseModel, Field


class ExtractedNode(BaseModel):
    name: str
    layer: str = "Component层"
    kind: str = "Component"
    description: str = ""


class ExtractedCall(BaseModel):
    source: str
    target: str
    type: str = "CALLS"
    description: str = ""


class ExtractedGraph(BaseModel):
    services: list[ExtractedNode] = Field(default_factory=list)
    calls: list[ExtractedCall] = Field(default_factory=list)


class GraphNode(BaseModel):
    id: str
    name: str
    layer: str = "Component层"
    kind: str = "Component"
    description: str = ""


class GraphEdge(BaseModel):
    id: str = ""
    source: str
    target: str
    type: str = "CALLS"
    description: str = ""


class GraphResponse(BaseModel):
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
