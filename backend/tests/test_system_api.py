from __future__ import annotations

import json
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import auth, system_api
from app.models import GraphEdge, GraphNode, GraphResponse
from app.rca_decision import RcaDecisionService
from app.system_db import SystemDatabase


def test_orphan_delete_preview_uses_server_side_operation_name(monkeypatch) -> None:
    captured: dict = {}

    class FakeGraphAdminService:
        def preview_operation(self, **kwargs) -> dict:
            captured.update(kwargs)
            return {"id": "preview-1", "action": kwargs["action"]}

    monkeypatch.setattr(
        system_api, "_graph_admin_service", lambda: FakeGraphAdminService()
    )
    app = FastAPI()
    app.include_router(system_api.router)
    app.dependency_overrides[auth.require_user] = lambda: {
        "id": "admin-1",
        "role": "admin",
    }
    client = TestClient(app)

    response = client.post(
        "/api/admin/graph/orphan-nodes/operations/preview",
        json={"project_id": "project-1", "target_names": ["isolated-service"]},
    )

    assert response.status_code == 201
    assert response.json()["operation"]["action"] == "delete_orphan_nodes"
    assert captured == {
        "actor_id": "admin-1",
        "action": "delete_orphan_nodes",
        "project_id": "project-1",
        "target_names": ["isolated-service"],
    }


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


def test_log_batch_report_api_returns_node_frequency(tmp_path, monkeypatch) -> None:
    database = SystemDatabase(tmp_path / "api-report.db")
    monkeypatch.setattr(system_api, "get_system_db", lambda: database)
    operator = database.create_user("operator", "hash", "Operator", "EMP-001")
    project = database.create_project(operator["id"], "Order Platform", "production")
    batch = database.create_log_batch(
        project["id"],
        "logs.zip",
        "/tmp/logs.zip",
        "",
        "",
        "/tmp/output",
        operator["id"],
        batch_id="batch-001",
    )
    database.upsert_incident(
        {
            "project_id": project["id"],
            "log_batch_id": batch["id"],
            "external_incident_id": "I00001",
            "graph_incident_id": "batch-001:I00001",
            "title": "Redis timeout",
            "severity": "high",
            "root_candidate": "redis-2",
            "root_confidence": 0.91,
            "fault_mode": "REDIS_TIMEOUT",
            "chain_json": json.dumps(["redis-2", "gateway"]),
            "analysis_json": "{}",
            "detail_json": "{}",
        }
    )
    database.complete_log_batch(batch["id"], json.dumps({"events": 40, "windows": 6}), json.dumps([]))

    app = FastAPI()
    app.include_router(system_api.router)
    app.dependency_overrides[auth.require_user] = lambda: operator
    client = TestClient(app)

    unavailable = client.get(f"/api/projects/{project['id']}/logs/{batch['id']}/report")
    assert unavailable.status_code == 409

    generated = client.post(f"/api/projects/{project['id']}/logs/{batch['id']}/report/generate")
    assert generated.status_code == 202
    assert generated.json()["message"] == "report_analysis_started"
    assert generated.json()["batch"]["report_status"] == "processing"

    stored_batch = database.get_log_batch(batch["id"])
    assert stored_batch["report_status"] == "completed"
    assert stored_batch["report_requested_by"] == operator["id"]
    assert stored_batch["report_requested_at"]
    assert stored_batch["report_generated_at"]

    response = client.get(f"/api/projects/{project['id']}/logs/{batch['id']}/report")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store, no-cache, must-revalidate, max-age=0"
    report = response.json()["report"]
    assert report["summary"]["incident_count"] == 1
    assert report["summary"]["event_count"] == 40
    assert report["node_frequencies"][0]["node"] == "redis-2"
    assert report["node_frequencies"][0]["root_hits"] == 1
    assert report["node_frequencies"][0]["chain_hits"] == 1
    assert report["fault_modes"][0]["label"] == "Redis 访问超时"
    assert report["fault_modes"][0]["count"] == 1
    assert report["propagation_paths"][0]["path"] == ["redis-2", "gateway"]
    assert report["focus_nodes"][0]["node"] == "redis-2"
    assert any("redis-2" in item for item in report["executive_conclusions"])
    assert report["governance_recommendations"][0]["nodes"] == ["redis-2"]

    incident_id = report["incidents"][0]["id"]
    database.execute(
        "UPDATE incidents SET title = ?, root_candidate = ? WHERE id = ?",
        ("Redis 节点人工修正", "redis-primary", incident_id),
    )
    detail = client.get(f"/api/projects/{project['id']}/incidents/{incident_id}")
    assert detail.status_code == 200
    assert detail.headers["cache-control"] == "no-store, no-cache, must-revalidate, max-age=0"
    assert detail.json()["incident"]["title"] == "Redis 节点人工修正"
    assert detail.json()["incident"]["root_candidate"] == "redis-primary"

    resolved = client.patch(
        f"/api/projects/{project['id']}/incidents/{incident_id}/status",
        json={"status": "resolved", "resolution_note": "Redis 节点恢复"},
    )
    refreshed = client.get(f"/api/projects/{project['id']}/logs/{batch['id']}/report")

    assert resolved.status_code == 200
    assert refreshed.status_code == 200
    assert refreshed.headers["cache-control"] == "no-store, no-cache, must-revalidate, max-age=0"
    refreshed_report = refreshed.json()["report"]
    assert refreshed_report["summary"]["resolved_count"] == 1
    assert refreshed_report["summary"]["open_count"] == 0
    assert refreshed_report["incidents"][0]["status"] == "resolved"


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


def test_rca_decision_keeps_friendly_graph_on_selected_real_chain() -> None:
    service = RcaDecisionService(settings=SimpleNamespace(llm_disable_env_proxy=True))
    analysis = {
        "hypotheses": [
            {"rank": 1, "candidate": "gateway", "chain": ["gateway"], "summary": "gateway failed"},
            {
                "rank": 2,
                "candidate": "redis-2",
                "chain": ["redis-2", "login-service", "gateway"],
                "summary": "redis timeout propagated upstream",
            },
        ]
    }
    fallback = service._fallback_decision(analysis, source="fallback")
    result = service._normalize_model_result(
        {
            "selected_candidate": "redis-2",
            "most_likely_reasons": ["Redis 连接超时", "登录服务随后失败"],
            "display_chain": [
                {"node": "redis-2", "label": "Redis 实例不可用", "explanation": "连接被拒绝"},
                {"node": "invented-node", "label": "虚构节点"},
                {"node": "gateway", "label": "用户请求失败"},
            ],
        },
        analysis,
        fallback,
    )

    assert result["selected_candidate_rank"] == 2
    assert result["most_likely_reasons"] == ["Redis 连接超时", "登录服务随后失败"]
    assert [item["node"] for item in result["display_chain"]] == [
        "redis-2",
        "login-service",
        "gateway",
    ]
    assert result["display_chain"][0]["label"] == "Redis 实例不可用"
    assert "invented-node" not in str(result["display_chain"])


def test_rca_decision_is_grounded_by_architecture_node_ids_and_repairs_path() -> None:
    service = RcaDecisionService(settings=SimpleNamespace(llm_disable_env_proxy=True))
    architecture = GraphResponse(
        nodes=[
            GraphNode(id="redis-id", name="Redis 集群", kind="Cache"),
            GraphNode(id="uaa-id", name="认证服务", kind="Service"),
            GraphNode(
                id="gateway-id",
                name="API 网关",
                kind="Service",
                meta={"aliases": ["api-gateway"]},
            ),
        ],
        edges=[
            GraphEdge(source="认证服务", target="Redis 集群", type="DEPENDS_ON"),
            GraphEdge(source="API 网关", target="认证服务", type="CALLS"),
        ],
    )
    analysis = {
        "hypotheses": [
            {"rank": 1, "candidate": "api-gateway", "chain": ["api-gateway"], "summary": "gateway failed"},
        ]
    }
    fallback = service._fallback_decision(analysis, source="fallback")

    result = service._normalize_model_result(
        {
            "selected_node_id": "redis-id",
            "selected_fault_mode": "REDIS_CLUSTER_DOWN",
            "most_likely_reasons": ["Redis 集群返回 CLUSTERDOWN"],
            "troubleshooting_methods": ["检查 Redis 集群状态"],
            # The model skipped uaa-id; validation must fill it from real graph edges.
            "propagation_path": [
                {"node_id": "redis-id", "label": "Redis 集群故障"},
                {"node_id": "gateway-id", "label": "API 网关请求失败"},
                {"node_id": "invented-id", "label": "虚构节点"},
            ],
        },
        analysis,
        fallback,
        architecture,
    )

    assert result["selected_node_id"] == "redis-id"
    assert result["selected_candidate"] == "Redis 集群"
    assert result["selected_candidate_rank"] == 0
    assert [item["node_id"] for item in result["propagation_path"]] == [
        "redis-id",
        "uaa-id",
        "gateway-id",
    ]
    assert [item["node"] for item in result["display_chain"]] == [
        "Redis 集群",
        "认证服务",
        "API 网关",
    ]
    assert "invented-id" not in str(result["display_chain"])
    assert result["path_validation_warnings"]


def test_rca_prompt_contains_every_architecture_node_and_edge() -> None:
    service = RcaDecisionService(
        settings=SimpleNamespace(
            llm_disable_env_proxy=True,
            log_compression_enabled=False,
            log_compression_max_events=20,
        )
    )
    architecture = GraphResponse(
        nodes=[
            GraphNode(
                id="n1",
                name="API 网关",
                kind="Service",
                layer="接入层",
                meta={"aliases": ["api-gateway"], "ip": "10.10.3.10", "port": 8080},
            ),
            GraphNode(
                id="n2",
                name="Redis 集群",
                kind="Cache",
                meta={"host": "redis-prod", "port": 6379, "password": "must-not-leak"},
            ),
        ],
        edges=[GraphEdge(source="API 网关", target="Redis 集群", type="DEPENDS_ON")],
    )

    prompt, _ = service._build_prompt_with_meta({"timeline": []}, {"hypotheses": []}, architecture)

    assert '["n1","API 网关","SV"' in prompt
    assert '["n2","Redis 集群","CA"' in prompt
    assert '"api-gateway"' in prompt
    assert '["n1","n2","D"]' in prompt
    assert '"ip":["10.10.3.10"]' in prompt
    assert '"p":[8080]' in prompt
    assert '接入层' not in prompt
    assert 'must-not-leak' not in prompt
    assert '\n  "architecture_graph"' not in prompt


def test_rca_structured_checks_use_trusted_node_endpoint_and_reject_invented_command() -> None:
    service = RcaDecisionService(settings=SimpleNamespace(llm_disable_env_proxy=True))
    architecture = GraphResponse(
        nodes=[
            GraphNode(
                id="redis-id",
                name="Redis实例2",
                kind="Instance",
                meta={"ip": "10.10.3.22", "port": 6379},
            )
        ]
    )
    analysis = {"hypotheses": [{"rank": 1, "candidate": "Redis实例2", "chain": ["Redis实例2"]}]}
    fallback = service._fallback_decision(analysis, source="fallback")

    result = service._normalize_model_result(
        {
            "selected_node_id": "redis-id",
            "most_likely_reasons": ["Redis 集群状态异常"],
            "checks": [
                {
                    "node_id": "redis-id",
                    "action": "检查集群状态",
                    "target_fields": ["ip", "p"],
                    "command_template": "redis-cli -h {ip} -p {port} CLUSTER INFO",
                    "expected_result": "cluster_state:ok",
                },
                {
                    "node_id": "redis-id",
                    "action": "检查错误地址",
                    "command": "redis-cli -h 10.10.3.99 -p 6380 PING",
                },
            ],
            "propagation_path": [{"node_id": "redis-id"}],
        },
        analysis,
        fallback,
        architecture,
    )

    assert result["selected_node_runtime"]["ips"] == ["10.10.3.22"]
    assert "10.10.3.22:6379" in result["most_likely_reasons"][0]
    assert "redis-cli -h 10.10.3.22 -p 6379" in result["troubleshooting_methods"][0]
    assert "10.10.3.99" not in result["troubleshooting_methods"][1]
    assert any("未登记 IP" in warning for warning in result["path_validation_warnings"])


def test_cluster_root_lists_every_real_member_without_inventing_instance_root() -> None:
    service = RcaDecisionService(settings=SimpleNamespace(llm_disable_env_proxy=True))
    architecture = GraphResponse(
        nodes=[
            GraphNode(id="cluster-id", name="Redis生产集群", kind="Cluster"),
            GraphNode(
                id="redis-1-id",
                name="Redis实例1",
                kind="Instance",
                meta={"ip": "10.10.3.21", "port": 6379},
            ),
            GraphNode(
                id="redis-2-id",
                name="Redis实例2",
                kind="Instance",
                meta={"host": "redis-2", "ip": "10.10.3.22", "port": 6379},
            ),
            GraphNode(id="redis-3-id", name="Redis实例3", kind="Instance"),
        ],
        edges=[
            GraphEdge(source="Redis生产集群", target="Redis实例1", type="HAS_MEMBER"),
            GraphEdge(source="Redis生产集群", target="Redis实例2", type="HAS_MEMBER"),
            GraphEdge(source="Redis生产集群", target="Redis实例3", type="HAS_MEMBER"),
        ],
    )
    analysis = {
        "hypotheses": [
            {"rank": 1, "candidate": "Redis生产集群", "chain": ["Redis生产集群"]}
        ]
    }
    fallback = service._fallback_decision(analysis, source="fallback")

    result = service._normalize_model_result(
        {
            "selected_node_id": "cluster-id",
            "most_likely_reasons": ["日志只能确认 Redis 集群异常"],
            "propagation_path": [{"node_id": "cluster-id"}],
        },
        analysis,
        fallback,
        architecture,
        {"root_evidence": "CLUSTERDOWN The cluster is down", "timeline": []},
    )

    assert result["selected_node_id"] == "cluster-id"
    assert result["root_scope"] == "cluster"
    assert result["instance_resolution"] == "unresolved_members_listed"
    assert [item["node_id"] for item in result["possible_member_nodes"]] == [
        "redis-1-id",
        "redis-2-id",
        "redis-3-id",
    ]
    assert result["possible_member_nodes"][0]["target"] == "10.10.3.21:6379"
    assert result["possible_member_nodes"][1]["ips"] == ["10.10.3.22"]
    assert result["possible_member_nodes"][2]["metadata_status"] == "missing_endpoint"
    assert all(not item["direct_evidence"] for item in result["possible_member_nodes"])
    assert all(item["status"] == "needs_investigation" for item in result["possible_member_nodes"])

    grounded_fallback = service._ground_fallback_in_architecture(
        fallback,
        architecture,
        {"root_evidence": "CLUSTERDOWN The cluster is down"},
    )
    assert grounded_fallback["selected_node_id"] == "cluster-id"
    assert len(grounded_fallback["possible_member_nodes"]) == 3

    guarded = service._normalize_model_result(
        {
            "selected_node_id": "redis-2-id",
            "most_likely_reasons": ["模型猜测实例2异常"],
            "propagation_path": [{"node_id": "redis-2-id"}],
        },
        analysis,
        fallback,
        architecture,
        {"root_evidence": "CLUSTERDOWN The cluster is down"},
    )
    assert guarded["selected_node_id"] == "cluster-id"
    assert guarded["selected_candidate"] == "Redis生产集群"
    assert "模型猜测" not in guarded["most_likely_reason"]
    assert "不足以确认具体故障实例" in guarded["most_likely_reason"]
    assert any("缺少实例" in item for item in guarded["path_validation_warnings"])

    instance_grounded = service._normalize_model_result(
        {
            "selected_node_id": "redis-2-id",
            "most_likely_reasons": ["redis-2 节点连接失败"],
            "propagation_path": [{"node_id": "redis-2-id"}],
        },
        analysis,
        fallback,
        architecture,
        {"root_evidence": "redis-2 connection refused"},
    )
    assert instance_grounded["selected_node_id"] == "redis-2-id"
    assert instance_grounded["root_scope"] == "instance"


def test_reverse_membership_edges_still_expand_cluster_candidates() -> None:
    service = RcaDecisionService(settings=SimpleNamespace(llm_disable_env_proxy=True))
    architecture = GraphResponse(
        nodes=[
            GraphNode(id="limiter-id", name="限流组件组", kind="Component"),
            GraphNode(
                id="limiter-1-id",
                name="限流实例1",
                kind="Instance",
                meta={"ip": "10.10.4.11", "port": 8081},
            ),
            GraphNode(
                id="limiter-2-id",
                name="限流实例2",
                kind="Instance",
                meta={"ip": "10.10.4.12", "port": 8081},
            ),
        ],
        edges=[
            GraphEdge(source="限流实例1", target="限流组件组", type="BELONGS_TO"),
            GraphEdge(source="限流实例2", target="限流组件组", type="BELONGS_TO"),
        ],
    )
    analysis = {"hypotheses": [{"rank": 1, "candidate": "限流组件组", "chain": ["限流组件组"]}]}
    fallback = service._fallback_decision(analysis, source="fallback")

    result = service._normalize_model_result(
        {
            "selected_node_id": "limiter-id",
            "most_likely_reasons": ["限流组件异常"],
            "propagation_path": [{"node_id": "limiter-id"}],
        },
        analysis,
        fallback,
        architecture,
        {"root_evidence": "rate limiter rejected requests"},
    )

    assert result["selected_node_id"] == "limiter-id"
    assert [item["target"] for item in result["possible_member_nodes"]] == [
        "10.10.4.11:8081",
        "10.10.4.12:8081",
    ]


def test_cluster_without_members_returns_explicit_architecture_warning() -> None:
    service = RcaDecisionService(settings=SimpleNamespace(llm_disable_env_proxy=True))
    architecture = GraphResponse(
        nodes=[GraphNode(id="cluster-id", name="Redis生产集群", kind="Cluster")]
    )
    analysis = {"hypotheses": [{"rank": 1, "candidate": "Redis生产集群", "chain": ["Redis生产集群"]}]}
    fallback = service._fallback_decision(analysis, source="fallback")

    result = service._normalize_model_result(
        {
            "selected_node_id": "cluster-id",
            "most_likely_reasons": ["Redis 集群异常"],
            "propagation_path": [{"node_id": "cluster-id"}],
        },
        analysis,
        fallback,
        architecture,
        {"root_evidence": "CLUSTERDOWN"},
    )

    assert result["root_scope"] == "cluster"
    assert result["instance_resolution"] == "members_missing"
    assert result["possible_member_nodes"] == []
    assert "未找到" in result["member_resolution_warning"]


def test_virtual_group_with_one_member_resolves_directly_to_instance() -> None:
    service = RcaDecisionService(settings=SimpleNamespace(llm_disable_env_proxy=True))
    architecture = GraphResponse(
        nodes=[
            GraphNode(id="limiter-id", name="限流逻辑节点", kind="Service"),
            GraphNode(
                id="limiter-instance-id",
                name="限流实例",
                kind="Instance",
                meta={"ip": "10.10.4.20", "port": 9090},
            ),
        ],
        edges=[GraphEdge(source="限流逻辑节点", target="限流实例", type="CONTAINS")],
    )
    analysis = {"hypotheses": [{"rank": 1, "candidate": "限流逻辑节点", "chain": ["限流逻辑节点"]}]}
    fallback = service._fallback_decision(analysis, source="fallback")

    result = service._normalize_model_result(
        {
            "selected_node_id": "limiter-id",
            "most_likely_reasons": ["限流逻辑节点持续拒绝请求"],
            "propagation_path": [{"node_id": "limiter-id"}],
        },
        analysis,
        fallback,
        architecture,
        {"root_evidence": "rate limiter rejected requests"},
    )

    assert result["selected_node_id"] == "limiter-instance-id"
    assert result["selected_candidate"] == "限流实例"
    assert result["root_scope"] == "instance"
    assert result["possible_member_nodes"] == []
    assert result["selected_node_runtime"]["ips"] == ["10.10.4.20"]
    assert result["resolved_from_aggregate"]["node_id"] == "limiter-id"
    assert "10.10.4.20:9090" in result["troubleshooting_methods"][0]

    grounded_fallback = service._ground_fallback_in_architecture(
        fallback,
        architecture,
        {"root_evidence": "rate limiter rejected requests"},
    )
    assert grounded_fallback["selected_node_id"] == "limiter-instance-id"
    assert grounded_fallback["selected_candidate"] == "限流实例"


def test_rca_sends_complete_architecture_on_every_conversation_request() -> None:
    session = _FakeConversationSession(["conversation-1", "conversation-1"])
    service = RcaDecisionService(settings=_conversation_settings(), session=session)
    architecture = GraphResponse(nodes=[GraphNode(id="n1", name="API 网关", kind="Service")])
    detail = {"incident_id": "I1", "timeline": []}
    analysis = {"incident_id": "I1", "hypotheses": []}

    service.enrich(detail, analysis, architecture)
    service.enrich({**detail, "incident_id": "I2"}, {**analysis, "incident_id": "I2"}, architecture)

    assert '"n":[["n1","API 网关","SV"]]' in session.calls[0]["json"]["content"]
    assert '"n":[["n1","API 网关","SV"]]' in session.calls[1]["json"]["content"]
    assert '"conversation_id":"conversation-1"' not in session.calls[1]["json"]["content"]
    assert session.calls[1]["json"]["conversation_id"] == "conversation-1"


def test_incident_persistence_prefers_grounded_model_root_and_chain(tmp_path) -> None:
    database = SystemDatabase(tmp_path / "grounded.db")
    user = database.create_user("operator", "hash", "Operator", "EMP-001")
    project = database.create_project(str(user["id"]), "Order", "")
    batch = database.create_log_batch(
        str(project["id"]), "logs.zip", "/tmp/logs.zip", "", "", "/tmp/output", str(user["id"]),
    )
    analysis = {
        "incident_id": "batch:I00001",
        "hypotheses": [
            {"rank": 1, "candidate": "API 网关", "confidence": 0.75, "fault_mode": "APPLICATION_ERROR", "chain": ["API 网关"]},
        ],
        "llm_decision": {
            "source": "llm",
            "selected_node_id": "redis-id",
            "selected_candidate": "Redis 集群",
            "selected_fault_mode": "REDIS_CLUSTER_DOWN",
            "confidence": 0.93,
            "propagation_path": [
                {"node_id": "redis-id", "node": "Redis 集群"},
                {"node_id": "gateway-id", "node": "API 网关"},
            ],
        },
    }

    saved = system_api._persist_incidents(
        database,
        str(project["id"]),
        str(batch["id"]),
        str(user["id"]),
        [{"incident_id": "I00001", "root_service_candidate": "api-gateway"}],
        [analysis],
    )
    incident = database.get_incident(str(saved[0]["id"]))

    assert incident["root_candidate"] == "Redis 集群"
    assert incident["fault_mode"] == "REDIS_CLUSTER_DOWN"
    assert json.loads(incident["chain_json"]) == ["Redis 集群", "API 网关"]


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
