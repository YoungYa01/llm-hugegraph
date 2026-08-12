from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any


SEVERITIES = ("critical", "high", "medium", "low")


def build_log_batch_report(
    *,
    batch: dict[str, Any],
    incidents: list[dict[str, Any]],
    generated_at: str | None = None,
) -> dict[str, Any]:
    """Build a batch-level diagnostic report from persisted RCA incidents."""

    normalized_incidents = [_incident_row(item) for item in incidents]
    node_map: dict[str, dict[str, Any]] = {}
    root_nodes: set[str] = set()
    total_root_hits = 0
    total_chain_hits = 0

    for incident in normalized_incidents:
        incident_id = incident["id"]
        timestamp = incident.get("created_at") or ""
        root = str(incident.get("root_candidate") or "").strip()
        if root:
            root_nodes.add(root)
            total_root_hits += 1
            entry = _node_entry(node_map, root)
            entry["root_hits"] += 1
            entry["incident_ids"].add(incident_id)
            entry["latest_incident_at"] = _latest(entry["latest_incident_at"], timestamp)

        seen_in_chain: set[str] = set()
        for node in incident["chain"]:
            if not node or node in seen_in_chain:
                continue
            seen_in_chain.add(node)
            total_chain_hits += 1
            entry = _node_entry(node_map, node)
            entry["chain_hits"] += 1
            entry["incident_ids"].add(incident_id)
            entry["latest_incident_at"] = _latest(entry["latest_incident_at"], timestamp)

    node_frequencies = [
        {
            "node": node,
            "root_hits": int(entry["root_hits"]),
            "chain_hits": int(entry["chain_hits"]),
            "total_hits": int(entry["root_hits"]) + int(entry["chain_hits"]),
            "incident_count": len(entry["incident_ids"]),
            "incident_ids": sorted(entry["incident_ids"]),
            "latest_incident_at": entry["latest_incident_at"],
        }
        for node, entry in node_map.items()
    ]
    node_frequencies.sort(
        key=lambda item: (
            -int(item["total_hits"]),
            -int(item["chain_hits"]),
            -int(item["root_hits"]),
            str(item["node"]).lower(),
        )
    )

    summary = _summary(batch)
    severity_dist = _severity_dist(batch, normalized_incidents)
    incident_count = len(normalized_incidents)
    resolved_count = _resolved_count(batch, normalized_incidents)

    report_summary = {
        "incident_count": incident_count,
        "root_node_count": len(root_nodes),
        "node_count": len(node_frequencies),
        "total_root_hits": total_root_hits,
        "total_chain_hits": total_chain_hits,
        "event_count": int(summary.get("events") or summary.get("event_count") or 0),
        "window_count": int(summary.get("windows") or summary.get("window_count") or 0),
        "duration_seconds": summary.get("duration_seconds"),
        "severity_dist": severity_dist,
        "resolved_count": resolved_count,
        "open_count": max(0, incident_count - resolved_count),
        "top_node": node_frequencies[0] if node_frequencies else None,
    }

    return {
        "generated_at": generated_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "batch": _batch_row(batch),
        "summary": report_summary,
        "node_frequencies": node_frequencies,
        "incidents": normalized_incidents,
    }


def _node_entry(node_map: dict[str, dict[str, Any]], node: str) -> dict[str, Any]:
    if node not in node_map:
        node_map[node] = {
            "root_hits": 0,
            "chain_hits": 0,
            "incident_ids": set(),
            "latest_incident_at": "",
        }
    return node_map[node]


def _incident_row(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(item.get("id") or ""),
        "external_incident_id": str(item.get("external_incident_id") or ""),
        "title": str(item.get("title") or ""),
        "severity": str(item.get("severity") or "medium"),
        "status": str(item.get("status") or "open"),
        "root_candidate": str(item.get("root_candidate") or ""),
        "fault_mode": str(item.get("fault_mode") or ""),
        "root_confidence": float(item.get("root_confidence") or 0),
        "chain": _chain(item),
        "created_at": str(item.get("created_at") or ""),
        "updated_at": str(item.get("updated_at") or ""),
    }


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


def _summary(batch: dict[str, Any]) -> dict[str, Any]:
    value = batch.get("summary")
    if isinstance(value, dict):
        return value
    value = batch.get("summary_json")
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _batch_row(batch: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(batch.get("id") or ""),
        "project_id": str(batch.get("project_id") or ""),
        "filename": str(batch.get("filename") or ""),
        "train_filename": str(batch.get("train_filename") or ""),
        "status": str(batch.get("status") or ""),
        "created_at": str(batch.get("created_at") or ""),
        "completed_at": str(batch.get("completed_at") or ""),
    }


def _severity_dist(batch: dict[str, Any], incidents: list[dict[str, Any]]) -> dict[str, int]:
    # Incident severity can change after the batch report was generated. Always
    # aggregate the live incident rows instead of trusting a batch snapshot.
    del batch
    values = {key: 0 for key in SEVERITIES}
    for incident in incidents:
        severity = str(incident.get("severity") or "medium")
        values[severity if severity in values else "medium"] += 1
    return values


def _resolved_count(batch: dict[str, Any], incidents: list[dict[str, Any]]) -> int:
    # Batch-level resolved_count is only a list-page convenience field and may
    # be absent or stale for a single batch query.
    del batch
    return sum(1 for item in incidents if item.get("status") == "resolved")


def _latest(left: str, right: str) -> str:
    return max(left or "", right or "")
