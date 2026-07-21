from __future__ import annotations

import json

from app.auth import hash_password, token_hash, verify_password
from app.system_db import SystemDatabase


def test_user_project_incident_resolution_lifecycle(tmp_path) -> None:
    database = SystemDatabase(tmp_path / "system.db")
    encoded = hash_password("strong-password")
    assert verify_password("strong-password", encoded)
    assert not verify_password("wrong-password", encoded)

    user = database.create_user("operator", encoded, "Operator")
    assert user["role"] == "admin"
    database.create_session(token_hash("session-token"), user["id"], "2999-01-01T00:00:00+00:00")
    assert database.get_session_user(token_hash("session-token"), "2026-01-01T00:00:00+00:00")["id"] == user["id"]

    project = database.create_project(user["id"], "Order System", "production")
    batch = database.create_log_batch(
        project["id"],
        "logs.zip",
        "/tmp/logs.zip",
        "",
        "",
        "/tmp/output",
        user["id"],
        batch_id="batch-001",
    )
    assert batch["id"] == "batch-001"

    incident = database.upsert_incident(
        {
            "project_id": project["id"],
            "log_batch_id": batch["id"],
            "external_incident_id": "I00001",
            "graph_incident_id": "batch-001:I00001",
            "title": "Redis timeout",
            "severity": "high",
            "root_candidate": "redis-2",
            "root_confidence": 0.91,
            "fault_mode": "REDIS_UNREACHABLE",
            "chain_json": json.dumps(["redis-2", "redis-cluster", "order-service"]),
            "analysis_json": json.dumps({"decision": "redis-2 unavailable"}),
            "detail_json": json.dumps({"primary_trace_id": "trace-1"}),
        }
    )
    database.add_incident_action(incident["id"], user["id"], "detected", "automatic")
    updated = database.update_incident_status(
        incident["id"], "resolved", "replaced redis-2", user["id"]
    )

    assert updated["status"] == "resolved"
    assert updated["resolved_by"] == user["id"]
    assert database.dashboard(project["id"])["resolved_incidents"] == 1
    actions = database.list_incident_actions(incident["id"])
    assert [item["action"] for item in actions] == ["resolved", "detected"]


def test_project_and_incident_filters_are_isolated(tmp_path) -> None:
    database = SystemDatabase(tmp_path / "system.db")
    first = database.create_user("first", hash_password("password-1"), "First")
    second = database.create_user("second", hash_password("password-2"), "Second")
    project_a = database.create_project(first["id"], "A", "")
    project_b = database.create_project(second["id"], "B", "")

    assert [item["id"] for item in database.list_projects(first["id"])] == [project_a["id"]]
    assert [item["id"] for item in database.list_projects(second["id"])] == [project_b["id"]]


def test_delete_log_batch_cascades_incidents_and_actions(tmp_path) -> None:
    database = SystemDatabase(tmp_path / "system.db")
    user = database.create_user("operator", hash_password("password-1"), "Operator")
    project = database.create_project(user["id"], "Order", "")
    batch = database.create_log_batch(
        project["id"], "logs.zip", "/tmp/logs.zip", "", "", "/tmp/out", user["id"]
    )
    incident = database.upsert_incident(
        {
            "project_id": project["id"],
            "log_batch_id": batch["id"],
            "external_incident_id": "I00001",
            "graph_incident_id": "batch:I00001",
            "title": "Redis timeout",
            "severity": "high",
        }
    )
    database.add_incident_action(incident["id"], user["id"], "detected")

    assert database.delete_log_batch(batch["id"])
    assert database.get_log_batch(batch["id"]) is None
    assert database.get_incident(incident["id"]) is None
    assert database.list_incident_actions(incident["id"]) == []
