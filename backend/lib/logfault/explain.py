from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import numpy as np
import pandas as pd


ROOT_KEYWORDS = (
    "rediscommandtimeoutexception",
    "redisconnectionexception",
    "communications exception",
    "communicationsexception",
    "deadlock",
    "sqltransientconnectionexception",
    "sqlintegrityconstraintviolationexception",
    "connection refused",
    "read timed out",
    "hikaripool",
)
UPSTREAM_KEYWORDS = (
    "bad gateway",
    "downstreamserviceexception",
    "downstream call",
    "downstream service",
)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def annotate_windows(
    metadata: pd.DataFrame,
    feature_matrix: pd.DataFrame,
    standardized: np.ndarray,
    scores: np.ndarray,
    flags: np.ndarray,
    events: pd.DataFrame,
    explain_config: dict,
) -> pd.DataFrame:
    result = metadata.copy()
    result["anomaly_score"] = scores
    result["is_anomaly"] = flags
    top_n = int(explain_config.get("top_templates", 10))
    top_trace_n = int(explain_config.get("top_trace_ids", 10))
    feature_names = feature_matrix.columns.to_numpy()

    template_contributors: list[str] = []
    service_lists: list[str] = []
    trace_lists: list[str] = []
    error_counts: list[int] = []

    for index, row in result.iterrows():
        z = np.abs(standardized[index])
        top_indices = np.argsort(z)[::-1][:top_n]
        contributors = [
            {
                "feature": str(feature_names[i]),
                "abs_zscore": round(float(z[i]), 6),
                "count": int(feature_matrix.iloc[index, i]),
            }
            for i in top_indices
            if feature_matrix.iloc[index, i] > 0 or z[i] > 0
        ]
        mask = (events["timestamp"] >= row["window_start"]) & (events["timestamp"] < row["window_end"])
        window_events = events.loc[mask]
        signal_events = window_events.loc[window_events["level"].isin(["ERROR", "WARN"])]
        service_source = signal_events if not signal_events.empty else window_events
        trace_source = signal_events if not signal_events.empty else window_events
        services = sorted(service_source["service"].dropna().astype(str).unique().tolist())
        traces = (
            trace_source.loc[trace_source["trace_id"].astype(str) != "", "trace_id"]
            .value_counts()
            .head(top_trace_n)
            .index.astype(str)
            .tolist()
        )
        template_contributors.append(_json(contributors))
        service_lists.append(_json(services))
        trace_lists.append(_json(traces))
        error_counts.append(int((window_events["level"] == "ERROR").sum()))

    result["top_template_contributors"] = template_contributors
    result["services"] = service_lists
    result["trace_ids"] = trace_lists
    result["error_count"] = error_counts
    return result


def _candidate_score(row: pd.Series, incident_start: pd.Timestamp) -> float:
    text = " ".join(
        str(row.get(key, ""))
        for key in ["message", "semantic_message", "root_cause", "raw_block"]
    ).lower()
    score = 0.0
    if row.get("level") == "ERROR":
        score += 5.0
    if row.get("root_exception_class"):
        score += 3.0
    if any(keyword in text for keyword in ROOT_KEYWORDS):
        score += 5.0
    if any(keyword in text for keyword in UPSTREAM_KEYWORDS):
        score -= 2.5
    seconds = max((pd.Timestamp(row["timestamp"]) - incident_start).total_seconds(), 0.0)
    score += max(0.0, 2.0 - seconds / 120.0)
    return score


def merge_anomaly_windows(
    windows: pd.DataFrame,
    events: pd.DataFrame,
    explain_config: dict,
) -> tuple[pd.DataFrame, list[dict]]:
    abnormal = windows.loc[windows["is_anomaly"]].sort_values("window_start")
    if abnormal.empty:
        return pd.DataFrame(columns=["incident_id", "start", "end", "max_score", "window_count"]), []

    merge_gap = pd.Timedelta(minutes=int(explain_config.get("merge_gap_minutes", 1)))
    groups: list[list[pd.Series]] = []
    current: list[pd.Series] = []
    current_end: pd.Timestamp | None = None

    for _, row in abnormal.iterrows():
        if not current or current_end is None or row["window_start"] <= current_end + merge_gap:
            current.append(row)
            current_end = max(current_end, row["window_end"]) if current_end is not None else row["window_end"]
        else:
            groups.append(current)
            current = [row]
            current_end = row["window_end"]
    if current:
        groups.append(current)

    incident_rows: list[dict] = []
    details: list[dict] = []
    timeline_limit = int(explain_config.get("max_timeline_events", 200))

    for number, group in enumerate(groups, start=1):
        start = min(row["window_start"] for row in group)
        end = max(row["window_end"] for row in group)
        incident_id = f"I{number:05d}"
        mask = (events["timestamp"] >= start) & (events["timestamp"] < end)
        incident_events = events.loc[mask].copy().sort_values("timestamp")
        error_events = incident_events.loc[incident_events["level"] == "ERROR"].copy()

        if not error_events.empty:
            error_events["root_candidate_score"] = error_events.apply(
                _candidate_score, axis=1, incident_start=start
            )
            candidates = error_events.sort_values(
                ["root_candidate_score", "timestamp"], ascending=[False, True]
            ).head(10)
        else:
            candidates = error_events

        signal_events = error_events if not error_events.empty else incident_events.loc[
            incident_events["level"] == "WARN"
        ]
        if signal_events.empty:
            signal_events = incident_events
        traces = (
            signal_events.loc[signal_events["trace_id"].astype(str) != "", "trace_id"]
            .value_counts()
            .head(10)
            .index.astype(str)
            .tolist()
        )
        services = sorted(signal_events["service"].astype(str).unique().tolist())
        root_service = str(candidates.iloc[0]["service"]) if not candidates.empty else ""
        root_cause = (
            str(candidates.iloc[0]["root_cause"] or candidates.iloc[0]["semantic_message"])
            if not candidates.empty
            else ""
        )

        incident_rows.append(
            {
                "incident_id": incident_id,
                "start": start,
                "end": end,
                "max_score": max(float(row["anomaly_score"]) for row in group),
                "window_count": len(group),
                "event_count": len(incident_events),
                "error_count": len(error_events),
                "services": _json(services),
                "trace_ids": _json(traces),
                "root_service_candidate": root_service,
                "root_cause_candidate": root_cause,
            }
        )

        timeline_columns = [
            "timestamp", "level", "service", "instance", "trace_id", "logger",
            "message", "root_cause", "template_id", "template", "source_file", "source_line",
        ]
        timeline = incident_events[timeline_columns].head(timeline_limit).copy()
        timeline["timestamp"] = timeline["timestamp"].astype(str)
        candidate_columns = [
            "timestamp", "service", "trace_id", "message", "root_cause",
            "root_exception_class", "root_candidate_score", "source_file", "source_line",
        ]
        candidate_records = candidates[candidate_columns].copy() if not candidates.empty else candidates
        if not candidates.empty:
            candidate_records["timestamp"] = candidate_records["timestamp"].astype(str)

        details.append(
            {
                "incident_id": incident_id,
                "start": str(start),
                "end": str(end),
                "services": services,
                "trace_ids": traces,
                "root_service_candidate": root_service,
                "root_cause_candidate": root_cause,
                "root_candidates": candidate_records.to_dict(orient="records") if not candidates.empty else [],
                "timeline": timeline.to_dict(orient="records"),
            }
        )

    return pd.DataFrame(incident_rows), details
