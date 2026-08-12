from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime, timezone
from typing import Any


SEVERITIES = ("critical", "high", "medium", "low")
STATUS_VALUES = ("open", "in_progress", "resolved", "ignored")
FAULT_MODE_LABELS = {
    "REDIS_CLUSTER_DOWN": "Redis 集群不可用",
    "CLUSTERDOWN": "Redis 集群不可用",
    "REDIS_TIMEOUT": "Redis 访问超时",
    "CONNECTION_TIMEOUT": "下游连接超时",
    "TIMEOUT": "请求处理超时",
    "CONNECTION_REFUSED": "连接被拒绝",
    "HTTP_404": "接口资源不存在",
    "NOT_FOUND": "接口资源不存在",
    "APPLICATION_ERROR": "应用程序异常",
    "DATABASE_ERROR": "数据库访问异常",
}


def build_log_batch_report(
    *,
    batch: dict[str, Any],
    incidents: list[dict[str, Any]],
    generated_at: str | None = None,
) -> dict[str, Any]:
    """Build an auditable batch RCA report from persisted incident decisions."""

    normalized_incidents = [_incident_row(item) for item in incidents]
    node_frequencies = _node_frequencies(normalized_incidents)
    fault_modes = _fault_mode_distribution(normalized_incidents)
    propagation_paths = _propagation_paths(normalized_incidents)
    severity_dist = _severity_dist(normalized_incidents)
    status_dist = _status_dist(normalized_incidents)
    summary_data = _summary(batch)
    incident_count = len(normalized_incidents)
    resolved_count = status_dist["resolved"]
    average_confidence = (
        sum(item["root_confidence"] for item in normalized_incidents) / incident_count
        if incident_count
        else 0
    )

    report_summary = {
        "incident_count": incident_count,
        "root_node_count": len({item["root_candidate"] for item in normalized_incidents if item["root_candidate"]}),
        "node_count": len(node_frequencies),
        "event_count": int(summary_data.get("events") or summary_data.get("event_count") or 0),
        "window_count": int(summary_data.get("windows") or summary_data.get("window_count") or 0),
        "duration_seconds": summary_data.get("duration_seconds"),
        "severity_dist": severity_dist,
        "status_dist": status_dist,
        "resolved_count": resolved_count,
        "open_count": max(0, incident_count - resolved_count),
        "resolution_rate": round(resolved_count / incident_count, 4) if incident_count else 0,
        "average_confidence": round(average_confidence, 4),
        "top_node": node_frequencies[0] if node_frequencies else None,
        "top_fault_mode": fault_modes[0] if fault_modes else None,
        "top_path": propagation_paths[0] if propagation_paths else None,
    }
    conclusions = _executive_conclusions(
        report_summary,
        node_frequencies,
        fault_modes,
        propagation_paths,
    )
    focus_nodes = _focus_node_analyses(node_frequencies, normalized_incidents)
    recommendations = _governance_recommendations(
        report_summary,
        node_frequencies,
        fault_modes,
        normalized_incidents,
    )

    return {
        "generated_at": generated_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "analysis_source": "structured_rca_summary",
        "batch": _batch_row(batch),
        "summary": report_summary,
        "executive_conclusions": conclusions,
        "node_frequencies": node_frequencies,
        "fault_modes": fault_modes,
        "propagation_paths": propagation_paths,
        "focus_nodes": focus_nodes,
        "governance_recommendations": recommendations,
        "incidents": normalized_incidents,
    }


def _incident_row(item: dict[str, Any]) -> dict[str, Any]:
    analysis = _object(item.get("analysis", item.get("analysis_json")))
    detail = _object(item.get("detail", item.get("detail_json")))
    decision = analysis.get("llm_decision") if isinstance(analysis.get("llm_decision"), dict) else {}
    evidence = _representative_evidence(analysis, detail)
    suggestions = _text_list(decision.get("troubleshooting_methods"))
    notes = _text_list(decision.get("notes"))
    return {
        "id": str(item.get("id") or ""),
        "external_incident_id": str(item.get("external_incident_id") or ""),
        "title": str(item.get("title") or ""),
        "severity": str(item.get("severity") or "medium"),
        "status": str(item.get("status") or "open"),
        "root_candidate": str(item.get("root_candidate") or "").strip(),
        "fault_mode": str(item.get("fault_mode") or "").strip(),
        "fault_mode_label": _fault_mode_label(str(item.get("fault_mode") or "")),
        "root_confidence": float(item.get("root_confidence") or 0),
        "chain": _chain(item),
        "representative_evidence": evidence,
        "troubleshooting_methods": suggestions,
        "notes": notes,
        "created_at": str(item.get("created_at") or ""),
        "updated_at": str(item.get("updated_at") or ""),
    }


def _node_frequencies(incidents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    node_map: dict[str, dict[str, Any]] = {}
    for incident in incidents:
        incident_id = incident["id"]
        root = incident["root_candidate"]
        if root:
            entry = _node_entry(node_map, root)
            entry["root_hits"] += 1
            entry["incident_ids"].add(incident_id)
            entry["fault_modes"].update([incident["fault_mode_label"]] if incident["fault_mode_label"] else [])
            entry["latest_incident_at"] = max(entry["latest_incident_at"], incident["created_at"])
        for node in dict.fromkeys(incident["chain"]):
            if not node:
                continue
            entry = _node_entry(node_map, node)
            entry["chain_hits"] += 1
            entry["incident_ids"].add(incident_id)
            entry["latest_incident_at"] = max(entry["latest_incident_at"], incident["created_at"])

    incident_count = max(1, len(incidents))
    result = []
    for node, entry in node_map.items():
        result.append(
            {
                "node": node,
                "root_hits": entry["root_hits"],
                "chain_hits": entry["chain_hits"],
                "incident_count": len(entry["incident_ids"]),
                "root_ratio": round(entry["root_hits"] / incident_count, 4),
                "incident_ratio": round(len(entry["incident_ids"]) / incident_count, 4),
                "incident_ids": sorted(entry["incident_ids"]),
                "fault_modes": [name for name, _count in entry["fault_modes"].most_common(3)],
                "latest_incident_at": entry["latest_incident_at"],
            }
        )
    result.sort(
        key=lambda item: (
            -int(item["root_hits"]),
            -int(item["incident_count"]),
            -int(item["chain_hits"]),
            str(item["node"]).casefold(),
        )
    )
    return result


def _node_entry(node_map: dict[str, dict[str, Any]], node: str) -> dict[str, Any]:
    return node_map.setdefault(
        node,
        {
            "root_hits": 0,
            "chain_hits": 0,
            "incident_ids": set(),
            "fault_modes": Counter(),
            "latest_incident_at": "",
        },
    )


def _fault_mode_distribution(incidents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for incident in incidents:
        raw = incident["fault_mode"] or "UNCLASSIFIED"
        label = incident["fault_mode_label"] or "未分类故障"
        group = groups.setdefault(
            label,
            {"label": label, "count": 0, "raw_modes": set(), "incident_ids": [], "root_nodes": Counter()},
        )
        group["count"] += 1
        group["raw_modes"].add(raw)
        group["incident_ids"].append(incident["id"])
        if incident["root_candidate"]:
            group["root_nodes"][incident["root_candidate"]] += 1
    total = max(1, len(incidents))
    values = [
        {
            "label": item["label"],
            "count": item["count"],
            "ratio": round(item["count"] / total, 4),
            "raw_modes": sorted(item["raw_modes"]),
            "incident_ids": item["incident_ids"],
            "top_root_node": item["root_nodes"].most_common(1)[0][0] if item["root_nodes"] else "",
        }
        for item in groups.values()
    ]
    values.sort(key=lambda item: (-item["count"], item["label"]))
    return values


def _propagation_paths(incidents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, ...], dict[str, Any]] = {}
    for incident in incidents:
        chain = tuple(dict.fromkeys(part for part in incident["chain"] if part))
        if not chain and incident["root_candidate"]:
            chain = (incident["root_candidate"],)
        if not chain:
            continue
        group = groups.setdefault(
            chain,
            {"path": list(chain), "count": 0, "incident_ids": [], "fault_modes": Counter()},
        )
        group["count"] += 1
        group["incident_ids"].append(incident["id"])
        if incident["fault_mode_label"]:
            group["fault_modes"][incident["fault_mode_label"]] += 1
    total = max(1, len(incidents))
    values = [
        {
            "path": item["path"],
            "path_label": " → ".join(item["path"]),
            "count": item["count"],
            "ratio": round(item["count"] / total, 4),
            "incident_ids": item["incident_ids"],
            "fault_modes": [name for name, _count in item["fault_modes"].most_common(3)],
        }
        for item in groups.values()
    ]
    values.sort(key=lambda item: (-item["count"], -len(item["path"]), item["path_label"]))
    return values


def _executive_conclusions(
    summary: dict[str, Any],
    nodes: list[dict[str, Any]],
    fault_modes: list[dict[str, Any]],
    paths: list[dict[str, Any]],
) -> list[str]:
    count = int(summary["incident_count"])
    if not count:
        return ["本批次未形成可汇总的 RCA 故障记录。"]
    conclusions = [
        f"本批次共形成 {count} 个 RCA 故障结论，涉及 {summary['root_node_count']} 个根因节点和 {summary['node_count']} 个传播节点。"
    ]
    if nodes:
        top = nodes[0]
        conclusions.append(
            f"故障最集中于“{top['node']}”：{top['root_hits']} 次被判定为根因，出现在 {top['incident_count']} 个故障和 {top['chain_hits']} 条传播链中。"
        )
    if fault_modes:
        top_mode = fault_modes[0]
        conclusions.append(
            f"最主要的故障模式是“{top_mode['label']}”，共 {top_mode['count']} 次，占本批次故障的 {top_mode['ratio']:.0%}。"
        )
    if paths:
        top_path = paths[0]
        conclusions.append(
            f"最高频传播路径为“{top_path['path_label']}”，关联 {top_path['count']} 个故障。"
        )
    conclusions.append(
        f"当前已解决 {summary['resolved_count']} 个，仍有 {summary['open_count']} 个未完成闭环，批次治理完成率为 {summary['resolution_rate']:.0%}。"
    )
    return conclusions[:5]


def _focus_node_analyses(nodes: list[dict[str, Any]], incidents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {item["id"]: item for item in incidents}
    result = []
    root_nodes = [node for node in nodes if node["root_hits"] > 0]
    for node in root_nodes[:5]:
        related = [by_id[item_id] for item_id in node["incident_ids"] if item_id in by_id]
        affected = Counter()
        for incident in related:
            for item in incident["chain"]:
                if item != node["node"]:
                    affected[item] += 1
        evidence = next((item["representative_evidence"] for item in related if item["representative_evidence"]), "")
        mode_text = "、".join(node["fault_modes"]) or "尚未归一化"
        description = (
            f"“{node['node']}”在本批次中 {node['root_hits']} 次被定位为根因，"
            f"参与 {node['chain_hits']} 条传播链，主要表现为{mode_text}。"
        )
        result.append(
            {
                **node,
                "affected_nodes": [name for name, _count in affected.most_common(5)],
                "representative_evidence": evidence,
                "description": description,
            }
        )
    return result


def _governance_recommendations(
    summary: dict[str, Any],
    nodes: list[dict[str, Any]],
    fault_modes: list[dict[str, Any]],
    incidents: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not incidents:
        return []
    recommendations: list[dict[str, Any]] = []
    top_node = nodes[0] if nodes else None
    top_mode = fault_modes[0] if fault_modes else None
    if top_node:
        recommendations.append(
            {
                "priority": "P0" if top_node["root_ratio"] >= 0.5 else "P1",
                "title": f"优先治理高频根因节点：{top_node['node']}",
                "description": f"该节点关联 {top_node['incident_count']} 个故障、{top_node['root_hits']} 次作为根因，应优先核查其健康状态、容量和高可用机制。",
                "nodes": [top_node["node"]],
                "incident_count": top_node["incident_count"],
            }
        )
    if top_mode:
        recommendations.append(
            {
                "priority": "P1",
                "title": f"建立“{top_mode['label']}”专项检测与告警",
                "description": f"该模式出现 {top_mode['count']} 次，建议统一监控指标、告警阈值和标准处置手册。",
                "nodes": [top_mode["top_root_node"]] if top_mode["top_root_node"] else [],
                "incident_count": top_mode["count"],
            }
        )
    if summary["open_count"]:
        recommendations.append(
            {
                "priority": "P1",
                "title": "完成未闭环故障的验证与复盘",
                "description": f"仍有 {summary['open_count']} 个故障未标记为已解决，应补充恢复验证、解决说明和复发防护措施。",
                "nodes": [],
                "incident_count": summary["open_count"],
            }
        )
    model_steps = Counter(
        step
        for incident in incidents
        for step in incident["troubleshooting_methods"]
        if step
    )
    if model_steps:
        step, count = model_steps.most_common(1)[0]
        recommendations.append(
            {
                "priority": "P2",
                "title": "固化批次共性排查动作",
                "description": step,
                "nodes": [],
                "incident_count": count,
            }
        )
    return recommendations[:5]


def _representative_evidence(analysis: dict[str, Any], detail: dict[str, Any]) -> str:
    candidates: list[Any] = [
        detail.get("root_evidence"),
        detail.get("root_cause_candidate"),
        analysis.get("decision"),
    ]
    decision = analysis.get("llm_decision") if isinstance(analysis.get("llm_decision"), dict) else {}
    candidates.extend(_text_list(decision.get("most_likely_reasons")))
    for candidate in candidates:
        if isinstance(candidate, dict):
            candidate = candidate.get("message") or candidate.get("reason") or json.dumps(candidate, ensure_ascii=False)
        if isinstance(candidate, list):
            candidate = next((str(item) for item in candidate if str(item).strip()), "")
        text = re.sub(r"\s+", " ", str(candidate or "")).strip()
        if text:
            return text[:500]
    return ""


def _fault_mode_label(raw: str) -> str:
    key = re.sub(r"[^A-Z0-9]+", "_", raw.upper()).strip("_")
    if not key:
        return "未分类故障"
    if key in FAULT_MODE_LABELS:
        return FAULT_MODE_LABELS[key]
    if "REDIS" in key and ("DOWN" in key or "CLUSTER" in key):
        return "Redis 集群不可用"
    if "TIMEOUT" in key:
        return "请求或连接超时"
    if "404" in key or "NOT_FOUND" in key:
        return "接口资源不存在"
    if "CONNECT" in key:
        return "连接异常"
    return raw.strip() or "未分类故障"


def _chain(item: dict[str, Any]) -> list[str]:
    value = item.get("chain", item.get("chain_json", []))
    if isinstance(value, list):
        return [str(part).strip() for part in value if str(part).strip()]
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return [part.strip() for part in text.split("->") if part.strip()]
        if isinstance(parsed, list):
            return [str(part).strip() for part in parsed if str(part).strip()]
    return []


def _object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _text_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if value is None:
        return []
    text = str(value).strip()
    return [text] if text else []


def _summary(batch: dict[str, Any]) -> dict[str, Any]:
    value = batch.get("summary")
    if isinstance(value, dict):
        return value
    return _object(batch.get("summary_json"))


def _batch_row(batch: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(batch.get("id") or ""),
        "project_id": str(batch.get("project_id") or ""),
        "filename": str(batch.get("filename") or ""),
        "train_filename": str(batch.get("train_filename") or ""),
        "status": str(batch.get("status") or ""),
        "created_at": str(batch.get("created_at") or ""),
        "completed_at": str(batch.get("completed_at") or ""),
        "selected_start_time": str(batch.get("selected_start_time") or ""),
        "selected_end_time": str(batch.get("selected_end_time") or ""),
    }


def _severity_dist(incidents: list[dict[str, Any]]) -> dict[str, int]:
    values = {key: 0 for key in SEVERITIES}
    for incident in incidents:
        severity = incident["severity"]
        values[severity if severity in values else "medium"] += 1
    return values


def _status_dist(incidents: list[dict[str, Any]]) -> dict[str, int]:
    values = {key: 0 for key in STATUS_VALUES}
    for incident in incidents:
        status = incident["status"]
        values[status if status in values else "open"] += 1
    return values
