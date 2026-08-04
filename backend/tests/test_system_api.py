from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import auth, system_api
from app.rca_decision import RcaDecisionService
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
        json={"username": "operator", "password": "password-123", "display_name": "Operator", "employee_id": "EMP-001"},
    )
    assert registered.status_code == 201
    assert registered.json()["user"]["employee_id"] == "EMP-001"
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

    # Test Update Project (PUT /api/projects/{project_id})
    updated = client.put(
        f"/api/projects/{project_id}",
        headers=headers,
        json={"name": "Order Platform v2", "description": "Updated description", "status": "paused"},
    )
    assert updated.status_code == 200
    assert updated.json()["project"]["name"] == "Order Platform v2"
    assert updated.json()["project"]["description"] == "Updated description"
    assert updated.json()["project"]["status"] == "paused"

    # Test Get Project (GET /api/projects/{project_id})
    fetched = client.get(f"/api/projects/{project_id}", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["project"]["name"] == "Order Platform v2"

    # Test Delete Project (DELETE /api/projects/{project_id})
    deleted = client.delete(f"/api/projects/{project_id}", headers=headers)
    assert deleted.status_code == 200
    assert deleted.json()["message"] == "project_deleted"

    # Verify project list is empty
    empty_list = client.get("/api/projects", headers=headers)
    assert len(empty_list.json()["items"]) == 0

    assert client.get("/api/projects").status_code == 401


def test_registration_requires_non_blank_employee_id(tmp_path, monkeypatch) -> None:
    database = SystemDatabase(tmp_path / "api.db")
    monkeypatch.setattr(system_api, "get_system_db", lambda: database)
    monkeypatch.setattr(auth, "get_system_db", lambda: database)
    app = FastAPI()
    app.include_router(system_api.router)
    client = TestClient(app)

    missing = client.post(
        "/api/auth/register",
        json={"username": "operator", "password": "password-123", "display_name": "Operator"},
    )
    assert missing.status_code == 422

    blank = client.post(
        "/api/auth/register",
        json={
            "username": "operator",
            "password": "password-123",
            "display_name": "Operator",
            "employee_id": "   ",
        },
    )
    assert blank.status_code == 422


class _FakeConversationResponse:
    status_code = 200

    def __init__(self, conversation_id: str) -> None:
        self.text = "json-response"
        self.conversation_id = conversation_id

    def json(self) -> dict:
        return {"content": "ok", "data": {"conversation_id": self.conversation_id}}


class _FakeConversationSession:
    trust_env = True

    def __init__(self, conversation_ids: list[str]) -> None:
        self.conversation_ids = iter(conversation_ids)
        self.calls: list[dict] = []

    def post(self, url: str, **kwargs) -> _FakeConversationResponse:
        self.calls.append({"url": url, **kwargs})
        return _FakeConversationResponse(next(self.conversation_ids))


def _conversation_settings() -> SimpleNamespace:
    return SimpleNamespace(
        llm_disable_env_proxy=True,
        rca_decision_url="http://model/api/conversation",
        rca_decision_model_config_id="model-1",
        rca_decision_stream=False,
        rca_decision_assistant_role="general",
        rca_decision_assistant_name="normal_assistant",
        rca_decision_assistant_prompt="",
        rca_decision_code_language="",
        rca_decision_kb_id="",
        rca_decision_kb_name="",
        rca_decision_connect_timeout_seconds=10,
        rca_decision_timeout_seconds=90,
    )


def test_log_upload_conversation_lifecycle_and_employee_header() -> None:
    session = _FakeConversationSession(["conversation-1", "conversation-1"])
    service = RcaDecisionService(
        settings=_conversation_settings(),
        session=session,
        employee_id="EMP-001",
    )

    service._post_conversation("first")
    service._post_conversation("second")

    assert "conversation_id" not in session.calls[0]["json"]
    assert session.calls[1]["json"]["conversation_id"] == "conversation-1"
    assert all(call["headers"]["X-Ai-Coding-Key"] == "EMP-001" for call in session.calls)

    next_upload = _FakeConversationSession(["conversation-2"])
    RcaDecisionService(settings=_conversation_settings(), session=next_upload)._post_conversation("new upload")
    assert "conversation_id" not in next_upload.calls[0]["json"]


def test_architecture_requests_never_send_conversation_id() -> None:
    session = _FakeConversationSession(["ignored-1", "ignored-2"])
    service = RcaDecisionService(
        settings=_conversation_settings(),
        session=session,
        employee_id="EMP-002",
        continue_conversation=False,
    )

    service._post_conversation("chunk one")
    service._post_conversation("chunk two")

    assert all("conversation_id" not in call["json"] for call in session.calls)


def test_resolved_incident_requires_note(tmp_path, monkeypatch) -> None:
    database = SystemDatabase(tmp_path / "api.db")
    monkeypatch.setattr(system_api, "get_system_db", lambda: database)
    monkeypatch.setattr(auth, "get_system_db", lambda: database)
    app = FastAPI()
    app.include_router(system_api.router)
    client = TestClient(app)

    response = client.post(
        "/api/auth/register",
        json={"username": "operator", "password": "password-123", "display_name": "Operator", "employee_id": "EMP-001"},
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
        json={"username": "operator", "password": "password-123", "display_name": "Operator", "employee_id": "EMP-001"},
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
