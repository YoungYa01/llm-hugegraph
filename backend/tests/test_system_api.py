from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import auth, system_api
from app.system_db import SystemDatabase


def test_auth_project_and_dashboard_api(tmp_path, monkeypatch) -> None:
    database = SystemDatabase(tmp_path / "api.db")
    monkeypatch.setattr(system_api, "get_system_db", lambda: database)
    monkeypatch.setattr(auth, "get_system_db", lambda: database)
    app = FastAPI()
    app.include_router(system_api.router)
    client = TestClient(app)

    registered = client.post(
        "/api/auth/register",
        json={"username": "operator", "password": "password-123", "display_name": "Operator"},
    )
    assert registered.status_code == 201
    token = registered.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    created = client.post(
        "/api/projects",
        headers=headers,
        json={"name": "Order Platform", "description": "production"},
    )
    assert created.status_code == 201
    project_id = created.json()["project"]["id"]

    projects = client.get("/api/projects", headers=headers)
    assert [item["id"] for item in projects.json()["items"]] == [project_id]
    dashboard = client.get(f"/api/projects/{project_id}/dashboard", headers=headers)
    assert dashboard.status_code == 200
    assert dashboard.json()["dashboard"]["incidents"] == 0

    assert client.get("/api/projects").status_code == 401


def test_resolved_incident_requires_note(tmp_path, monkeypatch) -> None:
    database = SystemDatabase(tmp_path / "api.db")
    monkeypatch.setattr(system_api, "get_system_db", lambda: database)
    monkeypatch.setattr(auth, "get_system_db", lambda: database)
    app = FastAPI()
    app.include_router(system_api.router)
    client = TestClient(app)

    response = client.post(
        "/api/auth/register",
        json={"username": "operator", "password": "password-123", "display_name": "Operator"},
    )
    user_id = response.json()["user"]["id"]
    headers = {"Authorization": f"Bearer {response.json()['token']}"}
    project = database.create_project(user_id, "Order", "")
    batch = database.create_log_batch(project["id"], "a.log", "/tmp/a.log", "", "", "/tmp/out", user_id)
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
    url = f"/api/projects/{project['id']}/incidents/{incident['id']}/status"
    rejected = client.patch(url, headers=headers, json={"status": "resolved", "resolution_note": ""})
    assert rejected.status_code == 400
    accepted = client.patch(url, headers=headers, json={"status": "resolved", "resolution_note": "restarted redis-2"})
    assert accepted.status_code == 200
    assert accepted.json()["incident"]["status"] == "resolved"


def test_delete_log_batch_removes_files_incidents_and_dynamic_graph(tmp_path, monkeypatch) -> None:
    database = SystemDatabase(tmp_path / "api.db")
    monkeypatch.setattr(system_api, "get_system_db", lambda: database)
    monkeypatch.setattr(auth, "get_system_db", lambda: database)
    monkeypatch.setattr(
        system_api,
        "get_settings",
        lambda: SimpleNamespace(
            app_data_root=str(tmp_path / "data"),
            allow_registration=True,
        ),
    )

    cleaned: list[str] = []

    class FakeScopedGraph:
        def __init__(self, project_id: str) -> None:
            self.project_id = project_id

        def delete_incident_batch(self, prefix: str) -> dict[str, int]:
            cleaned.append(prefix)
            return {"deleted_dynamic_nodes": 4, "pruned_orphans": 1}

    monkeypatch.setattr(system_api, "ProjectScopedGraphClient", FakeScopedGraph)
    app = FastAPI()
    app.include_router(system_api.router)
    client = TestClient(app)
    response = client.post(
        "/api/auth/register",
        json={"username": "operator", "password": "password-123", "display_name": "Operator"},
    )
    user_id = response.json()["user"]["id"]
    headers = {"Authorization": f"Bearer {response.json()['token']}"}
    project = database.create_project(user_id, "Order", "")
    batch_id = "batch-delete-001"
    batch_dir = tmp_path / "data" / "projects" / project["id"] / "logs" / batch_id
    batch_dir.mkdir(parents=True)
    input_path = batch_dir / "wrong.zip"
    input_path.write_bytes(b"wrong")
    batch = database.create_log_batch(
        project["id"],
        input_path.name,
        str(input_path),
        "",
        "",
        str(batch_dir / "output"),
        user_id,
        batch_id=batch_id,
    )
    incident = database.upsert_incident(
        {
            "project_id": project["id"],
            "log_batch_id": batch["id"],
            "external_incident_id": "I00001",
            "graph_incident_id": "batch:I00001",
            "title": "wrong log",
            "severity": "low",
        }
    )

    deleted = client.delete(
        f"/api/projects/{project['id']}/logs/{batch_id}", headers=headers
    )
    assert deleted.status_code == 200
    assert deleted.json()["recoverable"] is False
    assert cleaned == [batch_id[:12]]
    assert not batch_dir.exists()
    assert database.get_log_batch(batch_id) is None
    assert database.get_incident(incident["id"]) is None
