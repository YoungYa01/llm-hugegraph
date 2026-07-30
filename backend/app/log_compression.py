from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


_LEVEL_WEIGHT = {
    "FATAL": 13.0,
    "CRITICAL": 13.0,
    "ERROR": 10.0,
    "WARN": 6.0,
    "WARNING": 6.0,
    "INFO": 1.5,
    "DEBUG": 0.4,
    "TRACE": 0.1,
}

_SIGNAL_RULES: tuple[tuple[re.Pattern[str], float, str], ...] = (
    (re.compile(r"(?i)outofmemory|oom|java heap space|metaspace"), 10.0, "memory_exhaustion"),
    (re.compile(r"(?i)deadlock|lock wait timeout"), 9.0, "deadlock"),
    (re.compile(r"(?i)connection refused|connection reset|broken pipe|no route to host"), 8.0, "connection_failure"),
    (re.compile(r"(?i)rediscommandtimeoutexception|redisconnectionexception"), 8.0, "redis_failure"),
    (re.compile(r"(?i)sqltransientconnectionexception|communicationsexception|hikaripool"), 8.0, "database_failure"),
    (re.compile(r"(?i)timeout|timed out|deadline exceeded"), 6.0, "timeout"),
    (re.compile(r"(?i)circuit.?breaker.*open|service unavailable|bad gateway|gateway timeout"), 5.0, "upstream_failure"),
    (re.compile(r"(?i)exception|\berror\b|failed|failure|panic|fatal"), 4.0, "exception_or_failure"),
    (re.compile(r"(?i)retry(?:ing)?|backoff|degraded|fallback"), 2.0, "recovery_signal"),
)

_TIMESTAMP_RE = re.compile(
    r"\b(?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}[T\s]\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b"
)
_UUID_RE = re.compile(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b")
_HEX_RE = re.compile(r"(?i)\b(?:0x)?[0-9a-f]{12,}\b")
_IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_NUMBER_RE = re.compile(r"(?<![A-Za-z_])[-+]?\d+(?:\.\d+)?(?:ms|s|m|h|kb|mb|gb|%)?(?![A-Za-z_])", re.IGNORECASE)
_QUOTED_ID_RE = re.compile(r"([=:]\s*)['\"]?[A-Za-z0-9_.:/-]{8,}['\"]?")
_SPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class LogCompressionConfig:
    enabled: bool = True
    max_chars: int = 12_000
    max_events: int = 48
    context_radius: int = 2
    max_patterns: int = 12
    max_message_chars: int = 700

    def normalized(self) -> "LogCompressionConfig":
        return LogCompressionConfig(
            enabled=bool(self.enabled),
            max_chars=max(1_500, int(self.max_chars)),
            max_events=max(4, int(self.max_events)),
            context_radius=max(0, min(int(self.context_radius), 8)),
            max_patterns=max(0, min(int(self.max_patterns), 50)),
            max_message_chars=max(120, min(int(self.max_message_chars), 4_000)),
        )


class LogContextCompressor:
    """Deterministically compress a long log timeline for an LLM prompt.

    The algorithm combines five signals:
    1. severity and known failure keywords;
    2. rarity of a normalized log pattern;
    3. first/last occurrence of repeated patterns;
    4. service/trace diversity;
    5. temporal neighbors around high-value events.

    It never asks another model to summarize the logs, so compression is cheap,
    reproducible, and usable in offline deployments.
    """

    def __init__(self, config: LogCompressionConfig | None = None) -> None:
        self.config = (config or LogCompressionConfig()).normalized()

    def compress(
        self,
        events: Iterable[dict[str, Any]] | None,
        *,
        root_evidence: Any = None,
    ) -> dict[str, Any]:
        raw_events = [item for item in (events or []) if isinstance(item, dict)]
        normalized = [self._normalize_event(item, index) for index, item in enumerate(raw_events)]
        if not normalized:
            return self._empty_payload()

        pattern_members: dict[str, list[int]] = defaultdict(list)
        for event in normalized:
            pattern_members[event["signature"]].append(event["index"])
        pattern_counts = {key: len(value) for key, value in pattern_members.items()}

        evidence_tokens = self._evidence_tokens(root_evidence)
        reasons_by_index: dict[int, set[str]] = defaultdict(set)
        scores: dict[int, float] = {}
        for event in normalized:
            score, reasons = self._score_event(event, pattern_counts[event["signature"]], evidence_tokens)
            scores[event["index"]] = score
            reasons_by_index[event["index"]].update(reasons)

        mandatory: set[int] = {0, len(normalized) - 1}
        reasons_by_index[0].add("timeline_start")
        reasons_by_index[len(normalized) - 1].add("timeline_end")

        # Keep first and last occurrences of high-signal repeated patterns.
        for signature, members in pattern_members.items():
            if len(members) <= 1:
                continue
            best = max(members, key=lambda idx: (scores[idx], -idx))
            if scores[best] >= 7.0:
                mandatory.add(members[0])
                mandatory.add(members[-1])
                reasons_by_index[members[0]].add("pattern_first")
                reasons_by_index[members[-1]].add("pattern_last")

        anchors = [
            idx
            for idx in range(len(normalized))
            if normalized[idx]["level"] in {"FATAL", "CRITICAL", "ERROR"} or scores[idx] >= 8.0
        ]
        anchors.sort(key=lambda idx: (-scores[idx], idx))
        # A pathological incident may contain thousands of ERROR lines. Preserve
        # the strongest anchors and use pattern summaries for the rest.
        anchor_limit = max(4, self.config.max_events // 2)
        anchors = anchors[:anchor_limit]
        mandatory.update(anchors)
        for idx in anchors:
            reasons_by_index[idx].add("failure_anchor")
            for offset in range(1, self.config.context_radius + 1):
                before = idx - offset
                after = idx + offset
                if before >= 0:
                    mandatory.add(before)
                    reasons_by_index[before].add(f"context_before_{offset}")
                if after < len(normalized):
                    mandatory.add(after)
                    reasons_by_index[after].add(f"context_after_{offset}")

        selected = self._select_indices(normalized, scores, mandatory)
        payload = self._build_payload(
            normalized,
            selected,
            scores,
            reasons_by_index,
            pattern_members,
        )
        return self._fit_budget(payload, normalized, scores, reasons_by_index, pattern_members)

    def _empty_payload(self) -> dict[str, Any]:
        return {
            "summary": {
                "compression_enabled": self.config.enabled,
                "original_events": 0,
                "selected_events": 0,
                "omitted_events": 0,
                "unique_patterns": 0,
                "original_chars": 0,
                "output_chars": 0,
                "compression_ratio": 1.0,
                "level_counts": {},
                "services": [],
                "trace_ids": [],
                "time_range": {"start": "", "end": ""},
            },
            "key_events": [],
            "repeated_patterns": [],
        }

    def _normalize_event(self, event: dict[str, Any], index: int) -> dict[str, Any]:
        level = str(event.get("level") or event.get("severity") or "INFO").strip().upper()
        if level == "WARNING":
            level = "WARN"
        message = self._event_message(event)
        template_id = str(event.get("template_id") or "").strip()
        template = str(event.get("template") or "").strip()
        service = str(event.get("service") or event.get("service_name") or "").strip()
        trace_id = str(event.get("trace_id") or event.get("traceId") or "").strip()
        signature_text = template or message
        signature = f"{service}|{level}|{template_id or self._normalize_pattern(signature_text)}"
        signals = [name for pattern, _, name in _SIGNAL_RULES if pattern.search(message)]
        return {
            "index": index,
            "timestamp": str(event.get("timestamp") or event.get("time") or "").strip(),
            "level": level,
            "service": service,
            "instance": str(event.get("instance") or event.get("host") or event.get("pod") or "").strip(),
            "trace_id": trace_id,
            "logger": str(event.get("logger") or "").strip(),
            "template_id": template_id,
            "message": self._truncate(message, self.config.max_message_chars),
            "root_cause": self._truncate(str(event.get("root_cause") or "").strip(), 500),
            "exception_class": str(event.get("root_exception_class") or event.get("exception_class") or "").strip(),
            "source_file": str(event.get("source_file") or "").strip(),
            "source_line": event.get("source_line"),
            "signature": signature,
            "signals": signals,
        }

    def _event_message(self, event: dict[str, Any]) -> str:
        candidates = (
            event.get("root_cause"),
            event.get("semantic_message"),
            event.get("message"),
            event.get("raw_block"),
            event.get("description"),
        )
        for value in candidates:
            text = str(value or "").strip()
            if text:
                return _SPACE_RE.sub(" ", text)
        return ""

    def _normalize_pattern(self, message: str) -> str:
        text = message.lower()
        text = _TIMESTAMP_RE.sub("<ts>", text)
        text = _UUID_RE.sub("<uuid>", text)
        text = _IP_RE.sub("<ip>", text)
        text = _HEX_RE.sub("<hex>", text)
        text = _QUOTED_ID_RE.sub(r"\1<id>", text)
        text = _NUMBER_RE.sub("<num>", text)
        text = _SPACE_RE.sub(" ", text).strip()
        return text[:500] or "<empty>"

    def _score_event(
        self,
        event: dict[str, Any],
        frequency: int,
        evidence_tokens: set[str],
    ) -> tuple[float, list[str]]:
        score = _LEVEL_WEIGHT.get(event["level"], 1.0)
        reasons = [f"level_{event['level'].lower()}"]
        for pattern, weight, name in _SIGNAL_RULES:
            if pattern.search(event["message"]):
                score += weight
                reasons.append(name)
        if event["root_cause"]:
            score += 4.0
            reasons.append("explicit_root_cause")
        if event["exception_class"]:
            score += 3.0
            reasons.append("exception_class")
        # Rare templates are valuable, but the cap prevents a one-off INFO line
        # from outranking a real ERROR solely because it is unique.
        score += min(4.0, 4.0 / math.sqrt(max(1, frequency)))
        if frequency == 1:
            reasons.append("rare_pattern")
        if event["trace_id"]:
            score += 0.5
        if evidence_tokens:
            event_tokens = self._evidence_tokens(
                " ".join([event["message"], event["root_cause"], event["service"], event["exception_class"]])
            )
            overlap = len(evidence_tokens & event_tokens)
            if overlap:
                score += min(6.0, overlap * 1.5)
                reasons.append("matches_root_evidence")
        return score, reasons

    def _select_indices(
        self,
        events: list[dict[str, Any]],
        scores: dict[int, float],
        mandatory: set[int],
    ) -> list[int]:
        capacity = self.config.max_events
        if len(mandatory) > capacity:
            # Keep boundaries plus the strongest mandatory events.
            boundaries = {0, len(events) - 1}
            remainder = sorted(mandatory - boundaries, key=lambda idx: (-scores[idx], idx))
            selected = set(boundaries)
            selected.update(remainder[: max(0, capacity - len(selected))])
        else:
            selected = set(mandatory)

        seen_patterns = Counter(events[idx]["signature"] for idx in selected)
        seen_services = Counter(events[idx]["service"] for idx in selected if events[idx]["service"])
        seen_traces = Counter(events[idx]["trace_id"] for idx in selected if events[idx]["trace_id"])

        candidates = [idx for idx in range(len(events)) if idx not in selected]
        while candidates and len(selected) < capacity:
            def utility(idx: int) -> tuple[float, int]:
                event = events[idx]
                diversity = 0.0
                if seen_patterns[event["signature"]] == 0:
                    diversity += 2.0
                if event["service"] and seen_services[event["service"]] == 0:
                    diversity += 1.5
                if event["trace_id"] and seen_traces[event["trace_id"]] == 0:
                    diversity += 1.0
                repetition_penalty = max(0, seen_patterns[event["signature"]] - 1) * 2.0
                return scores[idx] + diversity - repetition_penalty, -idx

            best = max(candidates, key=utility)
            selected.add(best)
            event = events[best]
            seen_patterns[event["signature"]] += 1
            if event["service"]:
                seen_services[event["service"]] += 1
            if event["trace_id"]:
                seen_traces[event["trace_id"]] += 1
            candidates.remove(best)

        return sorted(selected)

    def _build_payload(
        self,
        events: list[dict[str, Any]],
        selected: list[int],
        scores: dict[int, float],
        reasons_by_index: dict[int, set[str]],
        pattern_members: dict[str, list[int]],
    ) -> dict[str, Any]:
        level_counts = Counter(event["level"] for event in events)
        services = sorted({event["service"] for event in events if event["service"]})
        traces = sorted({event["trace_id"] for event in events if event["trace_id"]})
        original_chars = len(
            json.dumps(
                [
                    {
                        "timestamp": event["timestamp"],
                        "level": event["level"],
                        "service": event["service"],
                        "instance": event["instance"],
                        "trace_id": event["trace_id"],
                        "logger": event["logger"],
                        "template_id": event["template_id"],
                        "message": event["message"],
                        "root_cause": event["root_cause"],
                        "source_file": event["source_file"],
                        "source_line": event["source_line"],
                    }
                    for event in events
                ],
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )

        key_events = [
            self._prompt_event(
                events[idx],
                scores[idx],
                reasons_by_index[idx],
                len(pattern_members[events[idx]["signature"]]),
            )
            for idx in selected
        ]
        repeated_patterns = self._pattern_summaries(events, pattern_members)
        payload: dict[str, Any] = {
            "summary": {
                "compression_enabled": self.config.enabled,
                "original_events": len(events),
                "selected_events": len(key_events),
                "omitted_events": max(0, len(events) - len(key_events)),
                "unique_patterns": len(pattern_members),
                "original_chars": original_chars,
                "output_chars": 0,
                "compression_ratio": 1.0,
                "level_counts": dict(sorted(level_counts.items())),
                "services": services,
                "trace_ids": traces[:30],
                "time_range": {
                    "start": events[0]["timestamp"],
                    "end": events[-1]["timestamp"],
                },
            },
            "key_events": key_events,
            "repeated_patterns": repeated_patterns,
        }
        self._refresh_metrics(payload)
        return payload

    def _prompt_event(
        self,
        event: dict[str, Any],
        score: float,
        reasons: set[str],
        repeat_count: int,
    ) -> dict[str, Any]:
        result: dict[str, Any] = {
            "order": event["index"] + 1,
            "timestamp": event["timestamp"],
            "level": event["level"],
            "service": event["service"],
            "message": event["message"],
            "importance_score": round(score, 3),
            "selection_reasons": sorted(reasons),
            "pattern_occurrences": repeat_count,
        }
        for key in ("instance", "trace_id", "logger", "template_id", "root_cause", "exception_class", "source_file", "source_line"):
            value = event.get(key)
            if value not in (None, ""):
                result[key] = value
        return result

    def _pattern_summaries(
        self,
        events: list[dict[str, Any]],
        pattern_members: dict[str, list[int]],
    ) -> list[dict[str, Any]]:
        candidates: list[tuple[float, str, list[int]]] = []
        for signature, members in pattern_members.items():
            if len(members) <= 1:
                continue
            representative = max(
                members,
                key=lambda idx: (_LEVEL_WEIGHT.get(events[idx]["level"], 1.0), len(events[idx]["signals"]), -idx),
            )
            severity = _LEVEL_WEIGHT.get(events[representative]["level"], 1.0)
            priority = math.log2(len(members) + 1) * 2.0 + severity
            candidates.append((priority, signature, members))
        candidates.sort(key=lambda item: (-item[0], item[2][0]))

        summaries: list[dict[str, Any]] = []
        for _, signature, members in candidates[: self.config.max_patterns]:
            representative = max(
                members,
                key=lambda idx: (_LEVEL_WEIGHT.get(events[idx]["level"], 1.0), len(events[idx]["signals"]), -idx),
            )
            event = events[representative]
            summaries.append(
                {
                    "count": len(members),
                    "first_order": members[0] + 1,
                    "last_order": members[-1] + 1,
                    "first_timestamp": events[members[0]]["timestamp"],
                    "last_timestamp": events[members[-1]]["timestamp"],
                    "level": event["level"],
                    "service": event["service"],
                    "template_id": event["template_id"],
                    "representative_message": self._truncate(event["message"], 360),
                }
            )
        return summaries

    def _fit_budget(
        self,
        payload: dict[str, Any],
        events: list[dict[str, Any]],
        scores: dict[int, float],
        reasons_by_index: dict[int, set[str]],
        pattern_members: dict[str, list[int]],
    ) -> dict[str, Any]:
        max_chars = self.config.max_chars
        if self._serialized_size(payload) <= max_chars:
            return payload

        # Drop the lowest-value non-boundary events first while keeping at least four.
        while len(payload["key_events"]) > 4 and self._serialized_size(payload) > max_chars:
            removable = [
                item
                for item in payload["key_events"]
                if item.get("order") not in {1, len(events)}
            ]
            if not removable:
                break
            victim = min(
                removable,
                key=lambda item: (
                    float(item.get("importance_score") or 0.0),
                    -int(item.get("pattern_occurrences") or 1),
                    -int(item.get("order") or 0),
                ),
            )
            payload["key_events"].remove(victim)
            self._refresh_metrics(payload)

        while payload["repeated_patterns"] and self._serialized_size(payload) > max_chars:
            payload["repeated_patterns"].pop()
            self._refresh_metrics(payload)

        # Last-resort field shrinking still keeps valid JSON and event identity.
        message_limit = min(self.config.max_message_chars, 360)
        while self._serialized_size(payload) > max_chars and message_limit >= 120:
            for item in payload["key_events"]:
                item["message"] = self._truncate(str(item.get("message") or ""), message_limit)
                if item.get("root_cause"):
                    item["root_cause"] = self._truncate(str(item["root_cause"]), min(message_limit, 260))
            for item in payload["repeated_patterns"]:
                item["representative_message"] = self._truncate(
                    str(item.get("representative_message") or ""), min(message_limit, 240)
                )
            message_limit -= 60
            self._refresh_metrics(payload)

        if self._serialized_size(payload) > max_chars:
            for item in payload["key_events"]:
                item.pop("logger", None)
                item.pop("source_file", None)
                item.pop("source_line", None)
                item.pop("selection_reasons", None)
            payload["repeated_patterns"] = payload["repeated_patterns"][:3]
            self._refresh_metrics(payload)
        return payload

    def _refresh_metrics(self, payload: dict[str, Any]) -> None:
        summary = payload["summary"]
        summary["selected_events"] = len(payload["key_events"])
        summary["omitted_events"] = max(0, int(summary["original_events"]) - len(payload["key_events"]))
        # Two passes make output_chars converge after the value itself changes.
        for _ in range(2):
            size = self._serialized_size(payload)
            summary["output_chars"] = size
            original_chars = max(1, int(summary.get("original_chars") or 0))
            summary["compression_ratio"] = round(size / original_chars, 4)

    def _serialized_size(self, payload: dict[str, Any]) -> int:
        return len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

    def _evidence_tokens(self, value: Any) -> set[str]:
        if value is None:
            return set()
        if not isinstance(value, str):
            try:
                value = json.dumps(value, ensure_ascii=False)
            except Exception:
                value = str(value)
        tokens = re.findall(r"[A-Za-z][A-Za-z0-9_.-]{3,}|[\u4e00-\u9fff]{2,}", value.lower())
        stop = {"error", "exception", "failed", "failure", "日志", "故障", "服务", "原因", "发生"}
        return {token for token in tokens if token not in stop}

    @staticmethod
    def _truncate(text: str, limit: int) -> str:
        text = text.strip()
        if len(text) <= limit:
            return text
        return text[: max(1, limit - 1)].rstrip() + "…"


def compress_timeline(
    events: Iterable[dict[str, Any]] | None,
    *,
    max_chars: int = 12_000,
    max_events: int = 48,
    context_radius: int = 2,
    max_patterns: int = 12,
    max_message_chars: int = 700,
    root_evidence: Any = None,
) -> dict[str, Any]:
    compressor = LogContextCompressor(
        LogCompressionConfig(
            max_chars=max_chars,
            max_events=max_events,
            context_radius=context_radius,
            max_patterns=max_patterns,
            max_message_chars=max_message_chars,
        )
    )
    return compressor.compress(events, root_evidence=root_evidence)


def _cli() -> int:
    parser = argparse.ArgumentParser(description="Compress a JSON log timeline for an LLM prompt")
    parser.add_argument("input", help="JSON file containing a list or an object with a timeline field")
    parser.add_argument("--output", "-o", help="Output JSON file; defaults to stdout")
    parser.add_argument("--max-chars", type=int, default=12_000)
    parser.add_argument("--max-events", type=int, default=48)
    parser.add_argument("--context-radius", type=int, default=2)
    args = parser.parse_args()

    data = json.loads(Path(args.input).read_text(encoding="utf-8"))
    events = data.get("timeline", []) if isinstance(data, dict) else data
    if not isinstance(events, list):
        raise ValueError("input JSON must be a list or contain a list-valued timeline field")
    result = compress_timeline(
        events,
        max_chars=args.max_chars,
        max_events=args.max_events,
        context_radius=args.context_radius,
        root_evidence=data.get("root_evidence") if isinstance(data, dict) else None,
    )
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
