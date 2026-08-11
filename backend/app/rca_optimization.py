from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Iterable, Mapping


_STRONG_SIGNAL_RE = re.compile(
    r"(?i)(connection refused|connection reset|broken pipe|no route to host|"
    r"outofmemory|oom|java heap space|metaspace|deadlock|lock wait timeout|"
    r"timeout|timed out|deadline exceeded|disk full|no space left|"
    r"unavailable|authentication failed|access denied|panic|fatal)"
)
_NUMBER_RE = re.compile(r"(?<![A-Za-z_])[-+]?\d+(?:\.\d+)?(?:ms|s|m|h|kb|mb|gb|%)?(?![A-Za-z_])", re.IGNORECASE)
_IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_UUID_RE = re.compile(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b")
_SPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class TimelineSelection:
    events: list[tuple[int, dict[str, Any]]]
    total_events: int
    selected_events: int
    duplicate_events_skipped: int
    irrelevant_events_skipped: int


@dataclass(frozen=True)
class GraphPruningResult:
    nodes: list[Any]
    edges: list[Any]
    nodes_before: int
    edges_before: int
    orphan_nodes_skipped: int
    invalid_edges_skipped: int


def _setting(settings: Any, name: str, default: Any) -> Any:
    return getattr(settings, name, default)


def _event_text(event: Mapping[str, Any]) -> str:
    return " ".join(
        str(event.get(key) or "")
        for key in (
            "root_cause",
            "message",
            "semantic_message",
            "exception_class",
            "root_exception_class",
            "exception_chain",
            "incident_role",
        )
    ).strip()


def event_pattern_key(event: Mapping[str, Any]) -> str:
    service = str(event.get("service") or event.get("service_name") or "").strip().lower()
    level = str(event.get("level") or event.get("severity") or "INFO").strip().upper()
    template_id = str(event.get("template_id") or "").strip()
    if template_id:
        return f"{service}|{level}|template:{template_id}"

    text = _event_text(event).lower()
    text = _UUID_RE.sub("<uuid>", text)
    text = _IP_RE.sub("<ip>", text)
    text = _NUMBER_RE.sub("<num>", text)
    text = _SPACE_RE.sub(" ", text).strip()
    return f"{service}|{level}|{text[:320] or '<empty>'}"


def _score_event(
    event: Mapping[str, Any],
    *,
    root_timestamp: str,
    root_exception: str,
    candidate_ids: set[str],
    candidate_texts: tuple[str, ...],
) -> tuple[int, bool]:
    level = str(event.get("level") or event.get("severity") or "INFO").strip().upper()
    timestamp = str(event.get("timestamp") or event.get("time") or "").strip()
    event_id = str(event.get("event_id") or "").strip()
    role = str(event.get("incident_role") or "").strip().lower()
    text = _event_text(event).lower()

    score = 0
    mandatory = False
    if level in {"FATAL", "CRITICAL"}:
        score += 120
    elif level == "ERROR":
        score += 90
    elif level in {"WARN", "WARNING"}:
        score += 28

    if timestamp and timestamp == root_timestamp:
        score += 140
        mandatory = True
    if event_id and event_id in candidate_ids:
        score += 140
        mandatory = True
    if root_exception and root_exception in text:
        score += 100
        mandatory = True
    if role in {"root", "root_candidate", "root-candidate", "upstream_effect", "upstream-effect"}:
        score += 85
    if _STRONG_SIGNAL_RE.search(text):
        score += 75
    if any(candidate and candidate in text for candidate in candidate_texts):
        score += 65
    if event.get("root_cause"):
        score += 35
    if event.get("root_exception_class") or event.get("exception_class"):
        score += 30

    return score, mandatory


def select_relevant_timeline(
    timeline: Iterable[dict[str, Any]] | None,
    detail: Mapping[str, Any],
    settings: Any,
) -> TimelineSelection:
    events = [item for item in (timeline or []) if isinstance(item, dict)]
    total = len(events)
    if not events:
        return TimelineSelection([], 0, 0, 0, 0)

    if not bool(_setting(settings, "rca_graph_pruning_enabled", True)):
        return TimelineSelection(
            [(index, event) for index, event in enumerate(events, start=1)],
            total,
            total,
            0,
            0,
        )

    max_events = max(1, int(_setting(settings, "rca_graph_max_events", 24)))
    context_radius = max(0, min(5, int(_setting(settings, "rca_graph_context_radius", 1))))
    max_per_pattern = max(1, int(_setting(settings, "rca_graph_max_events_per_pattern", 2)))
    root_timestamp = str(detail.get("root_error_timestamp") or "").strip()
    root_exception = str(detail.get("root_exception_class") or "").strip().lower()
    candidates = [
        item
        for item in (detail.get("root_candidates") or [])
        if isinstance(item, dict)
    ]
    candidate_ids = {
        str(item.get("event_id") or "").strip()
        for item in candidates
        if str(item.get("event_id") or "").strip()
    }
    candidate_texts = tuple(
        str(item.get("root_cause") or item.get("message") or "").strip().lower()
        for item in candidates
        if str(item.get("root_cause") or item.get("message") or "").strip()
    )

    scores: dict[int, int] = {}
    mandatory: set[int] = set()
    anchors: set[int] = set()
    for index, event in enumerate(events):
        score, is_mandatory = _score_event(
            event,
            root_timestamp=root_timestamp,
            root_exception=root_exception,
            candidate_ids=candidate_ids,
            candidate_texts=candidate_texts,
        )
        if score > 0:
            scores[index] = score
            anchors.add(index)
        if is_mandatory:
            mandatory.add(index)

    if not anchors:
        first_error = next(
            (
                index
                for index, event in enumerate(events)
                if str(event.get("level") or "").upper() in {"ERROR", "FATAL", "CRITICAL"}
            ),
            0,
        )
        anchors.add(first_error)
        scores[first_error] = max(scores.get(first_error, 0), 1)

    selected = set(anchors)
    for index in tuple(anchors):
        if scores.get(index, 0) < 50:
            continue
        for offset in range(1, context_radius + 1):
            if index - offset >= 0:
                selected.add(index - offset)
            if index + offset < total:
                selected.add(index + offset)

    pattern_members: dict[str, list[int]] = defaultdict(list)
    for index in selected:
        pattern_members[event_pattern_key(events[index])].append(index)

    deduplicated: set[int] = set()
    duplicate_skipped = 0
    for members in pattern_members.values():
        ranked = sorted(
            members,
            key=lambda idx: (
                idx not in mandatory,
                -scores.get(idx, 0),
                idx,
            ),
        )
        keep = set(ranked[:max_per_pattern]) | (set(members) & mandatory)
        deduplicated.update(keep)
        duplicate_skipped += max(0, len(members) - len(keep))

    ranked = sorted(
        deduplicated,
        key=lambda idx: (
            idx not in mandatory,
            -scores.get(idx, 0),
            idx,
        ),
    )[:max_events]
    final_indices = sorted(ranked)
    selected_events = [(index + 1, events[index]) for index in final_indices]
    irrelevant_skipped = max(0, total - len(selected) - duplicate_skipped)
    return TimelineSelection(
        selected_events,
        total,
        len(selected_events),
        duplicate_skipped,
        irrelevant_skipped,
    )


def should_write_edge(relation_type: str, settings: Any) -> bool:
    relation = str(relation_type or "").upper()
    if relation == "CO_OCCURS_IN_TRACE":
        return bool(_setting(settings, "rca_graph_write_cooccurrence_edges", False))
    if relation == "TEMPORALLY_PRECEDES":
        return bool(_setting(settings, "rca_graph_write_temporal_edges", True))
    return True


def prune_pending_graph(
    nodes: Mapping[str, Any],
    edges: Mapping[Any, Any],
    known_names: set[str],
    *,
    enabled: bool = True,
) -> GraphPruningResult:
    node_values = list(nodes.values())
    edge_values = list(edges.values())
    if not enabled:
        return GraphPruningResult(
            node_values,
            edge_values,
            len(node_values),
            len(edge_values),
            0,
            0,
        )

    pending_names = set(nodes)
    valid_edges = [
        edge
        for edge in edge_values
        if (str(edge.source) in pending_names or str(edge.source) in known_names)
        and (str(edge.target) in pending_names or str(edge.target) in known_names)
        and str(edge.source) != str(edge.target)
    ]
    connected = {
        endpoint
        for edge in valid_edges
        for endpoint in (str(edge.source), str(edge.target))
    }
    essential = {
        name
        for name, node in nodes.items()
        if str(getattr(node, "kind", "")) == "Incident"
    }
    kept_names = connected | essential
    kept_nodes = [node for name, node in nodes.items() if name in kept_names]
    kept_edges = [
        edge
        for edge in valid_edges
        if (str(edge.source) in kept_names or str(edge.source) in known_names)
        and (str(edge.target) in kept_names or str(edge.target) in known_names)
    ]
    return GraphPruningResult(
        kept_nodes,
        kept_edges,
        len(node_values),
        len(edge_values),
        max(0, len(node_values) - len(kept_nodes)),
        max(0, len(edge_values) - len(valid_edges)),
    )
