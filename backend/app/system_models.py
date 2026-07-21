from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=40, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=1, max_length=80)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=128)


class ProjectCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)


class ProjectUpdateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    status: Literal["active", "paused", "archived"] = "active"


class IncidentStatusRequest(BaseModel):
    status: Literal["open", "in_progress", "resolved", "ignored"]
    resolution_note: str = Field(default="", max_length=10000)


class ArchitectureImportResponse(BaseModel):
    id: str
    status: str
    extracted_nodes: int = 0
    extracted_edges: int = 0

