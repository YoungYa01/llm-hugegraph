from __future__ import annotations

import json
import math
from typing import Any

import numpy as np
import pandas as pd


ROOT_KEYWORDS = (
    "rediscommandtimeoutexception",
    "redisconnectionexception",
    "jedisclusterexception",
    "rediscommandexecutionexception",
    "communications exception",
    "communicationsexception",
    "deadlock",
    "sqltransientconnectionexception",
    "sqlintegrityconstraintviolationexception",
    "connection refused",
    "read timed out",
    "unknownhostexception",
    "hikaripool",
)
UPSTREAM_KEYWORDS = (
    "bad gateway",
    "downstreamserviceexception",
    "downstream call",
    "downstream service",
)
ERROR_LEVELS = {"ERROR", "FATAL"}
TECHNICAL_FAULT_FAMILIES = {"redis", "database", "network", "timeout", "classloading"}


INCIDENT_COLUMNS = [
    "incident_id",
    "start",
    "end",
    "detected_window_start",
    "detected_window_end",
    "fault_start",
    "fault_end",
    "max_score",
    "window_count",
    "event_count",
    "error_count",
    "exception_class_count",
    "exception_classes",
    "services",
    "trace_ids",
    "primary_trace_id",
    "root_service_candidate",
    "root_cause_candidate",
    "root_exception_class",
    "detection_source",
]


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _string(value: Any) -> str:
    if value is None:
        return ""
    try:
        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    return str(value)


def _event_text(row: pd.Series | dict[str, Any]) -> str:
    getter = row.get
    return " ".join(
        _string(getter(key, ""))
        for key in ("message", "semantic_message", "root_cause", "raw_block")
    ).lower()


def _fault_family(row: pd.Series | dict[str, Any]) -> str:
    class_name = _string(row.get("root_exception_class") or row.get("exception_class")).lower()
    text = f"{class_name} {_event_text(row)}"
    if any(token in text for token in ("redis", "jedis", "lettuce")):
        return "redis"
    if any(token in text for token in ("sql", "jdbc", "hikari", "mysql", "postgres", "oracle", "database", "communications")):
        return "database"
    if any(token in text for token in ("classformat", "verifyerror", "noclassdeffound", "classnotfound", "linkageerror")):
        return "classloading"
    if any(token in text for token in ("socket", "connectexception", "unknownhost", "transportexception", "connection reset", "connection refused")):
        return "network"
    if any(token in text for token in ("timeout", "timed out")):
        return "timeout"
    if any(token in text for token in ("license", "password", "authentication", "authorization", "accessdenied")):
        return "authentication"
    if any(token in text for token in ("business", "illegalargument", "illegalstate")):
        return "business"
    return class_name or "unknown"


def _is_technical_error(row: pd.Series | dict[str, Any]) -> bool:
    """Return True for errors that normally represent a system/infrastructure fault.

    Business/authentication exceptions are still preserved in events.csv and may be
    attached as context, but they do not automatically create an Incident.
    """

    level = _string(row.get("level")).upper()
    if level not in ERROR_LEVELS:
        return False
    family = _fault_family(row)
    if family in TECHNICAL_FAULT_FAMILIES:
        return True
    return any(keyword in _event_text(row) for keyword in ROOT_KEYWORDS)


def annotate_windows(
    metadata: pd.DataFrame,
    feature_matrix: pd.DataFrame,
    standardized: np.ndarray,
    scores: np.ndarray,
    flags: np.ndarray,
    events: pd.DataFrame,
    explain_config: dict,
) -> pd.DataFrame:
    """Add explainability metadata and combine model + technical-fault rules.

    V3 does not equate every application ERROR with a system outage. Redis/DB/network/
    timeout/class-loading failures are protected, while ordinary business/authentication
    errors need model support (or explicit configuration) before becoming candidates.
    """

    result = metadata.copy()
    result["anomaly_score"] = scores
    result["model_is_anomaly"] = np.asarray(flags, dtype=bool)
    top_n = int(explain_config.get("top_templates", 10))
    top_trace_n = int(explain_config.get("top_trace_ids", 10))
    feature_names = feature_matrix.columns.to_numpy()

    template_contributors: list[str] = []
    service_lists: list[str] = []
    trace_lists: list[str] = []
    error_counts: list[int] = []
    technical_error_counts: list[int] = []
    root_signal_counts: list[int] = []
    final_flags: list[bool] = []
    anomaly_reasons: list[str] = []

    # V3: an ordinary business ERROR is not automatically a system Incident.
    # Only explicit opt-in protects every ERROR window. Technical failures and
    # known root signals remain protected by default.
    protect_all_errors = bool(explain_config.get("always_include_error_windows", False))
    protect_technical_errors = bool(explain_config.get("protect_technical_error_windows", True))
    protect_signals = bool(explain_config.get("include_known_root_signals", True))

    for position, (_, row) in enumerate(result.iterrows()):
        z = np.abs(standardized[position])
        top_indices = np.argsort(z)[::-1][:top_n]
        contributors = [
            {
                "feature": str(feature_names[i]),
                "abs_zscore": round(float(z[i]), 6),
                "count": int(feature_matrix.iloc[position, i]),
            }
            for i in top_indices
            if feature_matrix.iloc[position, i] > 0 or z[i] > 0
        ]
        mask = (events["timestamp"] >= row["window_start"]) & (events["timestamp"] < row["window_end"])
        window_events = events.loc[mask]
        levels = window_events["level"].fillna("").astype(str).str.upper()
        signal_events = window_events.loc[levels.isin(["ERROR", "FATAL", "WARN"])]
        service_source = signal_events if not signal_events.empty else window_events
        trace_source = signal_events if not signal_events.empty else window_events
        services = sorted(service_source["service"].dropna().astype(str).unique().tolist())
        traces = (
            trace_source.loc[trace_source["trace_id"].fillna("").astype(str) != "", "trace_id"]
            .value_counts()
            .head(top_trace_n)
            .index.astype(str)
            .tolist()
        )
        error_count = int(levels.isin(ERROR_LEVELS).sum())
        technical_error_count = int(
            window_events.apply(_is_technical_error, axis=1).sum()
        ) if not window_events.empty else 0
        root_signal_count = int(
            window_events.apply(
                lambda event: any(keyword in _event_text(event) for keyword in ROOT_KEYWORDS), axis=1
            ).sum()
        ) if not window_events.empty else 0

        reasons: list[str] = []
        model_flag = bool(flags[position])
        if model_flag:
            reasons.append("model")
        if protect_all_errors and error_count:
            reasons.append("all_error_rule")
        if protect_technical_errors and technical_error_count:
            reasons.append("technical_error_rule")
        if protect_signals and root_signal_count:
            reasons.append("root_signal_rule")

        template_contributors.append(_json(contributors))
        service_lists.append(_json(services))
        trace_lists.append(_json(traces))
        error_counts.append(error_count)
        technical_error_counts.append(technical_error_count)
        root_signal_counts.append(root_signal_count)
        final_flags.append(bool(reasons))
        anomaly_reasons.append("+".join(reasons) or "normal")

    result["top_template_contributors"] = template_contributors
    result["services"] = service_lists
    result["trace_ids"] = trace_lists
    result["error_count"] = error_counts
    result["technical_error_count"] = technical_error_counts
    result["root_signal_count"] = root_signal_counts
    result["is_anomaly"] = final_flags
    result["anomaly_reason"] = anomaly_reasons
    return result


def _candidate_score(
    row: pd.Series,
    incident_start: pd.Timestamp,
    class_count: int = 1,
) -> float:
    text = _event_text(row)
    level = _string(row.get("level")).upper()
    score = 0.0
    if level == "FATAL":
        score += 7.0
    elif level == "ERROR":
        score += 5.0
    elif level == "WARN":
        score += 1.0
    if _string(row.get("root_exception_class")):
        score += 4.0
    elif _string(row.get("exception_class")):
        score += 2.0
    if any(keyword in text for keyword in ROOT_KEYWORDS):
        score += 5.0
    if any(keyword in text for keyword in UPSTREAM_KEYWORDS):
        score -= 2.5
    seconds = max((pd.Timestamp(row["timestamp"]) - incident_start).total_seconds(), 0.0)
    score += max(0.0, 2.0 - seconds / 120.0)
    # Rare exception classes are often more diagnostic than a flood of repeated wrappers.
    score += 3.0 / math.sqrt(max(1, class_count))
    return round(score, 6)


def _merge_window_regions(abnormal: pd.DataFrame, explain_config: dict) -> list[dict[str, Any]]:
    if abnormal.empty:
        return []
    merge_gap = pd.Timedelta(minutes=float(explain_config.get("merge_gap_minutes", 1)))
    regions: list[dict[str, Any]] = []
    current_rows: list[pd.Series] = []
    current_end: pd.Timestamp | None = None

    for _, row in abnormal.sort_values("window_start").iterrows():
        start = pd.Timestamp(row["window_start"])
        end = pd.Timestamp(row["window_end"])
        if not current_rows or current_end is None or start <= current_end + merge_gap:
            current_rows.append(row)
            current_end = max(current_end, end) if current_end is not None else end
        else:
            regions.append(_region_from_rows(current_rows))
            current_rows = [row]
            current_end = end
    if current_rows:
        regions.append(_region_from_rows(current_rows))
    return regions


def _region_from_rows(rows: list[pd.Series]) -> dict[str, Any]:
    reasons = sorted(
        {
            reason
            for row in rows
            for reason in _string(row.get("anomaly_reason")).split("+")
            if reason and reason != "normal"
        }
    )
    return {
        "start": min(pd.Timestamp(row["window_start"]) for row in rows),
        "end": max(pd.Timestamp(row["window_end"]) for row in rows),
        "max_score": max(float(row.get("anomaly_score", 0.0)) for row in rows),
        "window_count": len(rows),
        "detection_source": "+".join(reasons) or "model",
    }


def _cluster_error_indices(error_events: pd.DataFrame, explain_config: dict) -> list[list[int]]:
    """Aggregate request-level ERROR rows into fault episodes.

    V2 accidentally treated traceId as an isolation boundary: two Redis timeout
    errors with different request traceIds could never merge. During one outage,
    hundreds of requests therefore became hundreds of Incidents. V3 makes traceId
    a *positive join signal*, not a split key. Same service/class or same
    service/fault-family can merge across different traceIds when they are close in
    time.
    """

    if error_events.empty:
        return []

    # Exact signatures may recur for a little longer than family-level variants.
    exact_gap = pd.Timedelta(
        minutes=float(
            explain_config.get(
                "same_signature_gap_minutes",
                explain_config.get("incident_split_gap_minutes", 8),
            )
        )
    )
    family_gap = pd.Timedelta(
        minutes=float(
            explain_config.get(
                "same_family_gap_minutes",
                explain_config.get("incident_split_gap_minutes", 5),
            )
        )
    )
    trace_gap = pd.Timedelta(
        minutes=float(
            explain_config.get(
                "trace_join_gap_minutes",
                explain_config.get("trace_split_gap_minutes", 10),
            )
        )
    )
    cross_service_gap = pd.Timedelta(minutes=float(explain_config.get("cross_service_gap_minutes", 2)))
    max_duration_minutes = float(explain_config.get("max_incident_duration_minutes", 0) or 0)
    max_duration = pd.Timedelta(minutes=max_duration_minutes) if max_duration_minutes > 0 else None
    merge_same_class_across_services = bool(explain_config.get("merge_same_class_across_services", False))
    merge_same_family_across_services = bool(explain_config.get("merge_same_family_across_services", False))

    clusters: list[dict[str, Any]] = []

    for index, row in error_events.sort_values(["timestamp", "source_file", "source_line"]).iterrows():
        timestamp = pd.Timestamp(row["timestamp"])
        trace_id = _string(row.get("trace_id"))
        service = _string(row.get("service"))
        family = _fault_family(row)
        exception_key = _string(row.get("root_exception_class")) or _string(row.get("exception_class")) or family

        selected: dict[str, Any] | None = None
        selected_score = -1
        for cluster in reversed(clusters):
            gap = timestamp - cluster["last"]
            if gap < pd.Timedelta(0):
                continue
            if max_duration is not None and timestamp - cluster["first"] > max_duration:
                continue

            same_trace = bool(trace_id and trace_id in cluster["traces"])
            same_class = exception_key in cluster["classes"]
            same_family = family in cluster["families"]
            same_service = bool(not service or not cluster["services"] or service in cluster["services"])

            score = -1
            if same_trace and gap <= trace_gap:
                score = 100
            elif same_class and same_service and gap <= exact_gap:
                score = 90
            elif same_family and same_service and gap <= family_gap:
                score = 80
            elif merge_same_class_across_services and same_class and gap <= cross_service_gap:
                score = 70
            elif merge_same_family_across_services and same_family and gap <= cross_service_gap:
                score = 60

            if score > selected_score:
                selected = cluster
                selected_score = score
                if score == 100:
                    break

        if selected is None or selected_score < 0:
            selected = {
                "indices": [],
                "first": timestamp,
                "last": timestamp,
                "traces": set(),
                "services": set(),
                "families": set(),
                "classes": set(),
            }
            clusters.append(selected)

        selected["indices"].append(int(index))
        selected["last"] = timestamp
        if trace_id:
            selected["traces"].add(trace_id)
        if service:
            selected["services"].add(service)
        selected["families"].add(family)
        selected["classes"].add(exception_key)

    return [cluster["indices"] for cluster in clusters]


def _ensure_event_columns(events: pd.DataFrame) -> pd.DataFrame:
    result = events.copy()
    defaults: dict[str, Any] = {
        "event_id": "",
        "level": "",
        "service": "",
        "instance": "",
        "trace_id": "",
        "logger": "",
        "message": "",
        "semantic_message": "",
        "exception_class": "",
        "root_exception_class": "",
        "root_cause": "",
        "exception_chain": "[]",
        "template_id": "",
        "template": "",
        "source_file": "",
        "source_line": 0,
        "raw_block": "",
    }
    for column, default in defaults.items():
        if column not in result.columns:
            result[column] = default
    missing = result["event_id"].fillna("").astype(str).str.strip() == ""
    result.loc[missing, "event_id"] = result.loc[missing].apply(
        lambda row: f"{_string(row.get('source_file'))}:{_string(row.get('source_line')) or row.name}", axis=1
    )
    result["timestamp"] = pd.to_datetime(result["timestamp"])
    return result.sort_values(["timestamp", "source_file", "source_line"]).copy()


def _model_supported_indices(events: pd.DataFrame, windows: pd.DataFrame) -> set[int]:
    if events.empty or windows.empty or "model_is_anomaly" not in windows.columns:
        return set()
    model_windows = windows.loc[windows["model_is_anomaly"].fillna(False).astype(bool)]
    supported: set[int] = set()
    for _, window in model_windows.iterrows():
        mask = (events["timestamp"] >= window["window_start"]) & (events["timestamp"] < window["window_end"])
        supported.update(int(index) for index in events.loc[mask].index)
    return supported


def _build_seeds(
    windows: pd.DataFrame,
    events: pd.DataFrame,
    explain_config: dict,
) -> tuple[list[dict[str, Any]], set[int]]:
    abnormal = windows.loc[windows["is_anomaly"]].sort_values("window_start")
    regions = _merge_window_regions(abnormal, explain_config)
    seeds: list[dict[str, Any]] = []
    assigned_errors: set[int] = set()
    model_supported = _model_supported_indices(events, windows)
    seed_all_region_errors = bool(explain_config.get("seed_all_error_events_within_candidate_region", False))
    seed_model_business_errors = bool(explain_config.get("seed_nontechnical_errors_on_model_windows", True))

    for region in regions:
        mask = (events["timestamp"] >= region["start"]) & (events["timestamp"] < region["end"])
        region_events = events.loc[mask]
        levels = region_events["level"].fillna("").astype(str).str.upper()
        error_events = region_events.loc[levels.isin(ERROR_LEVELS)]
        if not error_events.empty and not seed_all_region_errors:
            eligibility = error_events.apply(_is_technical_error, axis=1)
            if seed_model_business_errors:
                eligibility = eligibility | error_events.index.to_series().isin(model_supported)
            incident_errors = error_events.loc[eligibility.to_numpy(dtype=bool)]
        else:
            incident_errors = error_events
        clusters = _cluster_error_indices(incident_errors, explain_config)

        if clusters:
            for indices in clusters:
                primary = events.loc[indices]
                seeds.append(
                    {
                        **region,
                        "primary_indices": indices,
                        "fault_start": pd.Timestamp(primary["timestamp"].min()),
                        "fault_end": pd.Timestamp(primary["timestamp"].max()),
                    }
                )
                assigned_errors.update(indices)
        else:
            # A model-only anomaly without explicit ERROR still remains visible.
            signal = region_events.loc[levels == "WARN"]
            primary = signal if not signal.empty else region_events
            if not primary.empty:
                indices = [int(index) for index in primary.index]
                seeds.append(
                    {
                        **region,
                        "primary_indices": indices,
                        "fault_start": pd.Timestamp(primary["timestamp"].min()),
                        "fault_end": pd.Timestamp(primary["timestamp"].max()),
                    }
                )
                # A model-only region may still contain business ERROR rows. They
                # are already represented by this seed and must not be duplicated by
                # the optional all-error fallback below.
                primary_levels = primary["level"].fillna("").astype(str).str.upper()
                assigned_errors.update(
                    int(index) for index in primary.loc[primary_levels.isin(ERROR_LEVELS)].index
                )

    all_levels = events["level"].fillna("").astype(str).str.upper()
    all_errors = events.loc[all_levels.isin(ERROR_LEVELS)]
    unassigned = all_errors.loc[~all_errors.index.isin(assigned_errors)]
    if bool(explain_config.get("always_include_error_events", False)) and not unassigned.empty:
        for indices in _cluster_error_indices(unassigned, explain_config):
            primary = events.loc[indices]
            fault_start = pd.Timestamp(primary["timestamp"].min())
            fault_end = pd.Timestamp(primary["timestamp"].max())
            seeds.append(
                {
                    "start": fault_start,
                    "end": fault_end + pd.Timedelta(milliseconds=1),
                    "max_score": 0.0,
                    "window_count": 0,
                    "detection_source": "error_event_fallback",
                    "primary_indices": indices,
                    "fault_start": fault_start,
                    "fault_end": fault_end,
                }
            )
            assigned_errors.update(indices)

    seeds.sort(key=lambda seed: (seed["fault_start"], seed["fault_end"], seed["detection_source"]))
    return seeds, assigned_errors


def _timeline_for_seed(events: pd.DataFrame, seed: dict[str, Any], explain_config: dict) -> pd.DataFrame:
    primary = events.loc[seed["primary_indices"]]
    before = pd.Timedelta(seconds=float(explain_config.get("context_before_seconds", 60)))
    after = pd.Timedelta(seconds=float(explain_config.get("context_after_seconds", 120)))
    start = pd.Timestamp(seed["fault_start"]) - before
    end = pd.Timestamp(seed["fault_end"]) + after
    context_mask = (events["timestamp"] >= start) & (events["timestamp"] <= end)

    traces = {
        _string(value)
        for value in primary["trace_id"].tolist()
        if _string(value)
    }
    if traces:
        trace_mask = (
            events["trace_id"].fillna("").astype(str).isin(traces)
            & (events["timestamp"] >= pd.Timestamp(seed["start"]))
            & (events["timestamp"] < pd.Timestamp(seed["end"]))
        )
        context_mask = context_mask | trace_mask

    timeline = events.loc[context_mask | events.index.isin(seed["primary_indices"])].copy()
    timeline["incident_role"] = "context"
    levels = timeline["level"].fillna("").astype(str).str.upper()
    timeline.loc[levels.isin(ERROR_LEVELS), "incident_role"] = "related_error"
    timeline.loc[timeline.index.isin(seed["primary_indices"]), "incident_role"] = "error"
    return timeline.sort_values(["timestamp", "source_file", "source_line"])


def _rank_candidates(primary_errors: pd.DataFrame, incident_start: pd.Timestamp, max_candidates: int) -> pd.DataFrame:
    if primary_errors.empty:
        return primary_errors.copy()
    candidates = primary_errors.copy()
    candidates["exception_key"] = candidates.apply(
        lambda row: _string(row.get("root_exception_class"))
        or _string(row.get("exception_class"))
        or _fault_family(row),
        axis=1,
    )
    counts = candidates["exception_key"].value_counts().to_dict()
    candidates["fault_family"] = candidates.apply(_fault_family, axis=1)
    candidates["root_candidate_score"] = candidates.apply(
        lambda row: _candidate_score(row, incident_start, int(counts.get(row["exception_key"], 1))), axis=1
    )
    ranked = candidates.sort_values(
        ["root_candidate_score", "timestamp", "source_file", "source_line"],
        ascending=[False, True, True, True],
    )

    # First preserve one representative per exception class; then fill remaining slots.
    chosen: list[int] = []
    seen_classes: set[str] = set()
    for index, row in ranked.iterrows():
        key = _string(row["exception_key"])
        if key not in seen_classes:
            chosen.append(int(index))
            seen_classes.add(key)
        if len(chosen) >= max_candidates:
            break
    if len(chosen) < max_candidates:
        for index in ranked.index:
            if int(index) not in chosen:
                chosen.append(int(index))
            if len(chosen) >= max_candidates:
                break
    return ranked.loc[chosen].sort_values(
        ["root_candidate_score", "timestamp"], ascending=[False, True]
    )


def _exception_summary(primary_errors: pd.DataFrame, ranked: pd.DataFrame) -> list[dict[str, Any]]:
    if primary_errors.empty:
        return []
    source = primary_errors.copy()
    source["exception_key"] = source.apply(
        lambda row: _string(row.get("root_exception_class"))
        or _string(row.get("exception_class"))
        or _fault_family(row),
        axis=1,
    )
    score_by_index = ranked["root_candidate_score"].to_dict() if "root_candidate_score" in ranked else {}
    summaries: list[dict[str, Any]] = []
    for exception_key, group in source.groupby("exception_key", sort=False):
        ordered = group.copy()
        ordered["_score"] = [float(score_by_index.get(index, 0.0)) for index in ordered.index]
        representative = ordered.sort_values(["_score", "timestamp"], ascending=[False, True]).iloc[0]
        traces = sorted({_string(value) for value in group["trace_id"].tolist() if _string(value)})
        services = sorted({_string(value) for value in group["service"].tolist() if _string(value)})
        summaries.append(
            {
                "root_exception_class": _string(exception_key),
                "fault_family": _fault_family(representative),
                "count": int(len(group)),
                "first_timestamp": str(pd.Timestamp(group["timestamp"].min())),
                "last_timestamp": str(pd.Timestamp(group["timestamp"].max())),
                "services": services,
                "trace_ids": traces,
                "representative_event_id": _string(representative.get("event_id")),
                "representative_message": _string(
                    representative.get("root_cause") or representative.get("semantic_message") or representative.get("message")
                ),
                "source_file": _string(representative.get("source_file")),
                "source_line": int(representative.get("source_line") or 0),
            }
        )
    return sorted(summaries, key=lambda item: (-int(item["count"]), item["root_exception_class"]))


def _limit_timeline(timeline: pd.DataFrame, essential_indices: set[int], limit: int) -> pd.DataFrame:
    if len(timeline) <= limit:
        return timeline
    essential = timeline.loc[timeline.index.isin(essential_indices)]
    if len(essential) >= limit:
        return essential.sort_values("timestamp").head(limit)
    remaining = timeline.loc[~timeline.index.isin(essential_indices)]
    slots = limit - len(essential)
    if slots <= 0 or remaining.empty:
        return essential.sort_values("timestamp")
    positions = np.linspace(0, len(remaining) - 1, num=min(slots, len(remaining)), dtype=int)
    sampled = remaining.iloc[sorted(set(int(position) for position in positions))]
    return pd.concat([essential, sampled]).drop_duplicates().sort_values(["timestamp", "source_file", "source_line"])


def merge_anomaly_windows(
    windows: pd.DataFrame,
    events: pd.DataFrame,
    explain_config: dict,
    *,
    return_mappings: bool = False,
) -> Any:
    """Build incidents from anomalous regions, then split them by causal compatibility.

    Previous behaviour merged every overlapping five-minute window into one large
    incident.  That conflated unrelated exceptions and only exposed the top ten
    candidate rows.  This version treats windows as detection ranges, partitions
    ERROR/FATAL events into fault episodes by trace/fault-family/service/time and exports an auditable mapping.
    Different request traceIds do not imply different Incidents.

    Backwards compatibility: callers that do not request mappings still receive the
    original two values ``(incidents, incident_details)``.
    """

    prepared_events = _ensure_event_columns(events)
    if windows.empty:
        empty_incidents = pd.DataFrame(columns=INCIDENT_COLUMNS)
        empty_details: list[dict[str, Any]] = []
        empty = pd.DataFrame()
        return (empty_incidents, empty_details, empty, empty, empty) if return_mappings else (empty_incidents, empty_details)

    seeds, assigned_error_indices = _build_seeds(windows, prepared_events, explain_config)
    incident_rows: list[dict[str, Any]] = []
    details: list[dict[str, Any]] = []
    event_mapping_rows: list[dict[str, Any]] = []
    exception_mapping_rows: list[dict[str, Any]] = []
    timeline_limit = max(1, int(explain_config.get("max_timeline_events", 300)))
    max_candidates = max(1, int(explain_config.get("max_root_candidates", 30)))

    for number, seed in enumerate(seeds, start=1):
        incident_id = f"I{number:05d}"
        primary = prepared_events.loc[seed["primary_indices"]].copy()
        primary_levels = primary["level"].fillna("").astype(str).str.upper()
        primary_errors = primary.loc[primary_levels.isin(ERROR_LEVELS)]
        timeline = _timeline_for_seed(prepared_events, seed, explain_config)
        ranked = _rank_candidates(primary_errors, pd.Timestamp(seed["fault_start"]), max_candidates)
        exception_summary = _exception_summary(primary_errors, ranked)

        root_row = ranked.iloc[0] if not ranked.empty else (primary.iloc[0] if not primary.empty else None)
        root_index = int(root_row.name) if root_row is not None else -1
        if root_index >= 0 and root_index in timeline.index:
            timeline.loc[root_index, "incident_role"] = "root_candidate"

        essential_indices = set(int(index) for index in seed["primary_indices"])
        essential_indices.update(int(index) for index in ranked.index)
        timeline = _limit_timeline(timeline, essential_indices, timeline_limit)

        traces = sorted({_string(value) for value in primary["trace_id"].tolist() if _string(value)})
        services = sorted({_string(value) for value in primary["service"].tolist() if _string(value)})
        trace_counts = primary.loc[primary["trace_id"].fillna("").astype(str) != "", "trace_id"].value_counts()
        primary_trace = _string(trace_counts.index[0]) if not trace_counts.empty else ""
        root_service = _string(root_row.get("service")) if root_row is not None else ""
        root_cause = _string(
            root_row.get("root_cause") or root_row.get("semantic_message") or root_row.get("message")
        ) if root_row is not None else ""
        root_exception_class = _string(
            root_row.get("root_exception_class") or root_row.get("exception_class")
        ) if root_row is not None else ""
        fault_start = pd.Timestamp(seed["fault_start"])
        fault_end = pd.Timestamp(seed["fault_end"])

        incident_rows.append(
            {
                "incident_id": incident_id,
                "start": fault_start,
                "end": fault_end,
                "detected_window_start": pd.Timestamp(seed["start"]),
                "detected_window_end": pd.Timestamp(seed["end"]),
                "fault_start": fault_start,
                "fault_end": fault_end,
                "max_score": float(seed["max_score"]),
                "window_count": int(seed["window_count"]),
                "event_count": int(len(timeline)),
                "error_count": int(len(primary_errors)),
                "exception_class_count": int(len(exception_summary)),
                "exception_classes": _json([item["root_exception_class"] for item in exception_summary]),
                "services": _json(services),
                "trace_ids": _json(traces),
                "primary_trace_id": primary_trace,
                "root_service_candidate": root_service,
                "root_cause_candidate": root_cause,
                "root_exception_class": root_exception_class,
                "detection_source": _string(seed["detection_source"]),
            }
        )

        timeline_columns = [
            "event_id", "timestamp", "level", "service", "instance", "trace_id", "logger",
            "message", "semantic_message", "exception_class", "root_exception_class", "root_cause",
            "exception_chain", "template_id", "template", "source_file", "source_line", "incident_role",
        ]
        timeline_records = timeline[timeline_columns].copy()
        timeline_records["timestamp"] = timeline_records["timestamp"].astype(str)

        candidate_columns = [
            "event_id", "timestamp", "service", "instance", "trace_id", "message", "semantic_message",
            "exception_class", "root_exception_class", "root_cause", "exception_chain", "fault_family",
            "root_candidate_score", "source_file", "source_line",
        ]
        candidate_records = ranked[candidate_columns].copy() if not ranked.empty else pd.DataFrame(columns=candidate_columns)
        if not candidate_records.empty:
            candidate_records["timestamp"] = candidate_records["timestamp"].astype(str)

        root_evidence = candidate_records.iloc[0].to_dict() if not candidate_records.empty else {}
        details.append(
            {
                "incident_id": incident_id,
                "start": str(fault_start),
                "end": str(fault_end),
                "detected_window_start": str(pd.Timestamp(seed["start"])),
                "detected_window_end": str(pd.Timestamp(seed["end"])),
                "fault_start": str(fault_start),
                "fault_end": str(fault_end),
                "detection_source": _string(seed["detection_source"]),
                "services": services,
                "trace_ids": traces,
                "primary_trace_id": primary_trace,
                "root_service_candidate": root_service,
                "root_cause_candidate": root_cause,
                "root_exception_class": root_exception_class,
                "root_error_timestamp": str(root_evidence.get("timestamp") or ""),
                "root_evidence": root_evidence,
                "root_candidates": candidate_records.to_dict(orient="records"),
                "exception_summary": exception_summary,
                "exception_classes": exception_summary,
                "upstream_effects": [],
                "timeline": timeline_records.to_dict(orient="records"),
            }
        )

        primary_set = set(int(index) for index in seed["primary_indices"])
        mapped_indices: set[int] = set()
        for index, event in timeline.iterrows():
            mapped_indices.add(int(index))
            event_mapping_rows.append(
                {
                    "event_id": _string(event.get("event_id")),
                    "incident_id": incident_id,
                    "incident_role": _string(event.get("incident_role")),
                    "is_primary_assignment": bool(int(index) in primary_set),
                    "timestamp": str(pd.Timestamp(event["timestamp"])),
                    "level": _string(event.get("level")),
                    "service": _string(event.get("service")),
                    "trace_id": _string(event.get("trace_id")),
                    "root_exception_class": _string(event.get("root_exception_class")),
                    "source_file": _string(event.get("source_file")),
                    "source_line": int(event.get("source_line") or 0),
                    "assignment_reason": "trace_or_family_cluster" if int(index) in primary_set else "time_context",
                }
            )
        # Timeline has a display budget, but the audit mapping must never lose a
        # primary ERROR/FATAL merely because an incident contains hundreds of rows.
        for index in sorted(primary_set - mapped_indices):
            event = prepared_events.loc[index]
            event_mapping_rows.append(
                {
                    "event_id": _string(event.get("event_id")),
                    "incident_id": incident_id,
                    "incident_role": "error",
                    "is_primary_assignment": True,
                    "timestamp": str(pd.Timestamp(event["timestamp"])),
                    "level": _string(event.get("level")),
                    "service": _string(event.get("service")),
                    "trace_id": _string(event.get("trace_id")),
                    "root_exception_class": _string(event.get("root_exception_class")),
                    "source_file": _string(event.get("source_file")),
                    "source_line": int(event.get("source_line") or 0),
                    "assignment_reason": "primary_cluster_not_in_timeline_budget",
                }
            )
        for summary in exception_summary:
            exception_mapping_rows.append({"incident_id": incident_id, **summary})

    levels = prepared_events["level"].fillna("").astype(str).str.upper()
    all_errors = prepared_events.loc[levels.isin(ERROR_LEVELS)]
    unassigned = all_errors.loc[~all_errors.index.isin(assigned_error_indices)].copy()
    if not unassigned.empty:
        unassigned["fault_family"] = unassigned.apply(_fault_family, axis=1)
        unassigned["technical_error"] = unassigned.apply(_is_technical_error, axis=1)
        unassigned["unassigned_reason"] = unassigned.apply(
            lambda row: (
                "technical_error_outside_selected_episode"
                if bool(row.get("technical_error"))
                else "nontechnical_error_not_promoted_to_incident"
            ),
            axis=1,
        )

    incidents = pd.DataFrame(incident_rows, columns=INCIDENT_COLUMNS)
    event_mapping = pd.DataFrame(event_mapping_rows)
    exception_mapping = pd.DataFrame(exception_mapping_rows)
    if return_mappings:
        return incidents, details, event_mapping, exception_mapping, unassigned
    return incidents, details
