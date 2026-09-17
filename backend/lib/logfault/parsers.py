from __future__ import annotations

import json
import re
import shlex
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .schema import FileParseResult, ParsedEvent, UnparsedRecord


LEVEL_ALIASES = {
    "TRACE": "TRACE", "DEBUG": "DEBUG", "INFO": "INFO", "NOTICE": "INFO",
    "WARN": "WARN", "WARNING": "WARN", "ERR": "ERROR", "ERROR": "ERROR",
    "CRIT": "FATAL", "CRITICAL": "FATAL", "ALERT": "FATAL", "EMERG": "FATAL",
    "FATAL": "FATAL",
}
LEVEL_TOKEN = r"TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERR|ERROR|CRIT|CRITICAL|ALERT|EMERG|FATAL"
TIMESTAMP_TOKEN = (
    r"(?:\d{2}/\d{2}/\d{2}|\d{4}[-/]\d{2}[-/]\d{2})[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?"
    r"(?:Z|[+-]\d{2}:?\d{2})?"
)
INLINE_TRACE_RE = re.compile(
    r"(?i)\b(?:trace_?id|trace\.id)\s*[=:]\s*['\"]?([A-Za-z0-9_.-]{4,128})['\"]?"
)
INLINE_SPAN_RE = re.compile(
    r"(?i)\b(?:span_?id|span\.id)\s*[=:]\s*['\"]?([A-Za-z0-9_.-]{4,128})['\"]?"
)
INLINE_REQUEST_RE = re.compile(
    r"(?i)\b(?:request_?id|req_?id|correlation_?id|uuid)\s*[=:]\s*['\"]?([A-Za-z0-9_.-]{4,128})['\"]?"
)
TRACE_PREFIX_RE = re.compile(r"^\[(?P<trace>[A-Za-z0-9_.-]{4,128})\]\s*(?P<message>.*)$")
DOWNSTREAM_RE = re.compile(
    r"(?i)\b(?:downstream|target\s+physical\s+host|target\s+host|target_?service|"
    r"calling\s+downstream\s+service)\s*[=:]\s*['\"]?([A-Za-z0-9_.:-]{2,128})['\"]?"
)
EXCEPTION_HEADER_RE = re.compile(
    r"^(?:(?P<prefix>Caused by|Suppressed|InnerException)\s*:\s*)?"
    r"(?P<class>[A-Za-z_$][\w.$+]*(?:Exception|Error))"
    r"(?::\s*(?P<message>.*))?$",
    re.IGNORECASE,
)
EXCEPTION_SEARCH_RE = re.compile(r"(?P<class>[A-Za-z_$][\w.$+]*(?:Exception|Error))\b")
GO_PANIC_RE = re.compile(r"^panic:\s*(?P<message>.+)$", re.IGNORECASE)


def normalize_level(value: Any, default: str = "INFO") -> tuple[str, str]:
    raw = str(value or "").strip().upper()
    return LEVEL_ALIASES.get(raw, default), raw


def parse_timestamp(value: Any) -> tuple[datetime | None, bool]:
    raw = str(value or "").strip()
    if not raw:
        return None, False
    if re.fullmatch(r"\d{10}(?:\.\d+)?", raw):
        return datetime.fromtimestamp(float(raw), tz=timezone.utc).replace(tzinfo=None), False
    if re.fullmatch(r"\d{13,16}", raw):
        divisor = 1000 if len(raw) == 13 else 1_000_000
        return datetime.fromtimestamp(int(raw) / divisor, tz=timezone.utc).replace(tzinfo=None), False
    normalized = raw.replace(",", ".")
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    if re.search(r"[+-]\d{4}$", normalized):
        normalized = normalized[:-5] + normalized[-5:-2] + ":" + normalized[-2:]
    try:
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return parsed, False
    except ValueError:
        pass
    for fmt in (
        "%y/%m/%d %H:%M:%S.%f",
        "%Y-%m-%d %H:%M:%S.%f",
        "%Y/%m/%d %H:%M:%S.%f",
        "%d/%b/%Y:%H:%M:%S %z",
    ):
        try:
            parsed = datetime.strptime(normalized, fmt)
            if parsed.tzinfo is not None:
                parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
            return parsed, False
        except ValueError:
            continue
    return None, False


def _json_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value)


def _flatten(value: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    flattened: dict[str, Any] = {}
    for key, item in value.items():
        path = f"{prefix}.{key}" if prefix else str(key)
        flattened[path] = item
        if isinstance(item, dict):
            flattened.update(_flatten(item, path))
    return flattened


def _pick(values: dict[str, Any], aliases: Iterable[str]) -> Any:
    lowered = {key.lower(): value for key, value in values.items()}
    for alias in aliases:
        value = lowered.get(alias.lower())
        if value is not None and str(value).strip() != "":
            return value
    return ""


def _service_from_path(path: Path) -> str:
    stem = re.sub(r"-(?:err|error|debug|access)$", "", path.stem, flags=re.IGNORECASE)
    stem = re.sub(r"-\d+$", "", stem)
    return stem or (path.parent.name if path.parent.name not in {"", "."} else "unknown-service")


def _instance_from_path(path: Path, service: str) -> str:
    parent = path.parent.name
    return parent if parent not in {"", "."} else service


def _exception_details(first_message: str, continuation: list[str]) -> tuple[str, str, str, str]:
    entries: list[dict[str, str]] = []
    for line in [first_message, *continuation]:
        stripped = line.strip()
        match = EXCEPTION_HEADER_RE.match(stripped)
        if match:
            prefix = str(match.group("prefix") or "").lower()
            kind = (
                "caused_by" if prefix in {"caused by", "innerexception"}
                else "suppressed" if prefix == "suppressed" else "direct"
            )
            entries.append({
                "class": str(match.group("class") or ""),
                "message": str(match.group("message") or ""),
                "kind": kind,
            })
            continue
        panic = GO_PANIC_RE.match(stripped)
        if panic:
            entries.append({"class": "GoPanic", "message": panic.group("message"), "kind": "direct"})
    if not entries:
        token = EXCEPTION_SEARCH_RE.search(first_message)
        if token:
            entries.append({
                "class": token.group("class"),
                "message": first_message[token.end():].lstrip(": "),
                "kind": "direct",
            })
    if not entries:
        return "", "", "", "[]"
    non_suppressed = [entry for entry in entries if entry["kind"] != "suppressed"] or entries
    caused = [entry for entry in non_suppressed if entry["kind"] == "caused_by"]
    root = caused[-1] if caused else non_suppressed[-1]
    root_cause = f"{root['class']}: {root['message']}".rstrip(": ")
    return (
        non_suppressed[0]["class"], root["class"], root_cause,
        json.dumps(entries, ensure_ascii=False),
    )


def _ids_and_message(message: str, raw_text: str) -> tuple[str, str, str, str, str]:
    trace_id = ""
    cleaned = message
    prefix = TRACE_PREFIX_RE.match(message)
    if prefix:
        trace_id = prefix.group("trace")
        cleaned = prefix.group("message")
    if not trace_id:
        match = INLINE_TRACE_RE.search(raw_text)
        trace_id = match.group(1) if match else ""
    span = INLINE_SPAN_RE.search(raw_text)
    request = INLINE_REQUEST_RE.search(raw_text)
    downstream = DOWNSTREAM_RE.search(raw_text)
    return (
        trace_id,
        span.group(1) if span else "",
        request.group(1) if request else "",
        downstream.group(1) if downstream else "",
        cleaned,
    )


def build_event(
    *,
    timestamp: datetime,
    timestamp_raw: str,
    level: Any,
    message: str,
    continuation: list[str],
    source_path: Path,
    source_file: str,
    start_line: int,
    end_line: int,
    parser_name: str,
    confidence: float,
    service: str = "",
    instance: str = "",
    thread: str = "",
    logger: str = "",
    process_id: str = "",
    host: str = "",
    namespace: str = "",
    container: str = "",
    attributes: dict[str, Any] | None = None,
    timestamp_inferred: bool = False,
    warnings: list[str] | None = None,
    raw_block: str | None = None,
    trace_id_hint: str = "",
    span_id_hint: str = "",
    request_id_hint: str = "",
) -> ParsedEvent:
    normalized_level, raw_level = normalize_level(level)
    raw_text = "\n".join([message, *continuation])
    trace_id, span_id, request_id, downstream, cleaned_message = _ids_and_message(message, raw_text)
    trace_id = trace_id or trace_id_hint
    span_id = span_id or span_id_hint
    request_id = request_id or request_id_hint
    exception_class, root_exception_class, root_cause, exception_chain = _exception_details(
        cleaned_message, continuation
    )
    semantic_parts = [cleaned_message]
    if exception_class and exception_class not in cleaned_message:
        semantic_parts.append(exception_class)
    if root_cause and root_cause not in cleaned_message and root_cause != exception_class:
        semantic_parts.append(root_cause)
    resolved_service = service or _service_from_path(source_path)
    resolved_instance = instance or _instance_from_path(source_path, resolved_service)
    return ParsedEvent(
        timestamp=timestamp,
        level=normalized_level,
        service=resolved_service,
        instance=resolved_instance,
        thread=thread,
        logger=logger,
        trace_id=trace_id,
        message=cleaned_message,
        semantic_message=" | ".join(part for part in semantic_parts if part),
        exception_class=exception_class,
        root_exception_class=root_exception_class,
        root_cause=root_cause,
        exception_chain=exception_chain,
        raw_block=raw_block if raw_block is not None else "\n".join([message, *continuation]),
        source_file=source_file,
        source_line=start_line,
        downstream_target=downstream,
        source_line_end=end_line,
        timestamp_raw=timestamp_raw,
        timestamp_inferred=timestamp_inferred,
        level_raw=raw_level,
        span_id=span_id,
        request_id=request_id,
        host=host,
        namespace=namespace,
        container=container,
        process_id=process_id,
        attributes=json.dumps(attributes or {}, ensure_ascii=False, separators=(",", ":")),
        parser_name=parser_name,
        parse_confidence=round(float(confidence), 4),
        parse_warnings=json.dumps(warnings or [], ensure_ascii=False),
    )


class LogParser(ABC):
    name = "base"

    @abstractmethod
    def probe(self, lines: list[str]) -> float:
        raise NotImplementedError

    @abstractmethod
    def parse(self, lines: list[str], source_path: Path, source_file: str, confidence: float) -> FileParseResult:
        raise NotImplementedError


class HeaderBlockParser(LogParser):
    max_event_lines = 2000

    @abstractmethod
    def parse_header(self, line: str) -> dict[str, Any] | None:
        raise NotImplementedError

    def probe(self, lines: list[str]) -> float:
        nonempty = [line for line in lines if line.strip()]
        if not nonempty:
            return 0.0
        timestamp_candidates = [
            line for line in nonempty
            if re.match(r"^(?:\d{2}/\d{2}/\d{2}|\d{4}[-/]\d{2}[-/]\d{2})[ T]", line)
        ]
        candidates = timestamp_candidates or nonempty
        return sum(self.parse_header(line) is not None for line in candidates) / len(candidates)

    def parse(self, lines: list[str], source_path: Path, source_file: str, confidence: float) -> FileParseResult:
        result = FileParseResult(parser_name=self.name, parser_confidence=confidence, total_lines=len(lines))
        current: dict[str, Any] | None = None
        orphan: list[str] = []
        orphan_start = 1

        def emit() -> None:
            nonlocal current
            if current is None:
                return
            result.events.append(build_event(
                **current["header"],
                continuation=current["continuation"],
                source_path=source_path,
                source_file=source_file,
                start_line=current["start_line"],
                end_line=current["end_line"],
                parser_name=self.name,
                confidence=confidence,
                raw_block="\n".join([current["raw_header"], *current["continuation"]]),
            ))
            current = None

        for line_number, line in enumerate(lines, start=1):
            header = self.parse_header(line)
            if header is not None:
                if orphan:
                    result.unparsed.append(UnparsedRecord(
                        source_file, orphan_start, line_number - 1, "\n".join(orphan),
                        "content_before_first_recognized_event", self.name,
                    ))
                    orphan = []
                emit()
                current = {
                    "header": header,
                    "raw_header": line,
                    "continuation": [],
                    "start_line": line_number,
                    "end_line": line_number,
                }
            elif current is not None:
                if line_number - current["start_line"] + 1 <= self.max_event_lines:
                    current["continuation"].append(line)
                    current["end_line"] = line_number
                else:
                    warnings = current["header"].setdefault("warnings", [])
                    warnings.append("multiline_event_limit_reached")
                    emit()
                    orphan_start = line_number
                    orphan.append(line)
            else:
                if not orphan:
                    orphan_start = line_number
                orphan.append(line)
        emit()
        if orphan:
            result.unparsed.append(UnparsedRecord(
                source_file, orphan_start, len(lines), "\n".join(orphan),
                "no_recognized_event_header", self.name,
            ))
        return result


class SpringJavaParser(HeaderBlockParser):
    name = "spring_java"
    spring_re = re.compile(
        rf"^(?P<timestamp>{TIMESTAMP_TOKEN})\s+(?P<level>{LEVEL_TOKEN})\s+"
        r"(?:(?P<pid>\d+)\s+)?---\s+(?:\[(?P<context>[^\]]*)\]\s*)?"
        r"\[(?P<thread>[^\]]+)\]\s+(?P<logger>.*?)\s*:\s*(?P<message>.*)$",
        re.IGNORECASE,
    )
    log4j_re = re.compile(
        rf"^(?P<timestamp>{TIMESTAMP_TOKEN})\s+(?P<level>{LEVEL_TOKEN})\s+"
        r"\[(?P<thread>[^\]]+)\]\s+(?P<logger>\S.*?)\s+-\s+(?P<message>.*)$",
        re.IGNORECASE,
    )
    log4j_thread_first_re = re.compile(
        rf"^(?P<timestamp>{TIMESTAMP_TOKEN})\s+\[(?P<thread>[^\]]+)\]\s+"
        rf"(?P<level>{LEVEL_TOKEN})\s+(?P<logger>\S.*?)\s+-\s+(?P<message>.*)$",
        re.IGNORECASE,
    )

    def parse_header(self, line: str) -> dict[str, Any] | None:
        match = self.spring_re.match(line) or self.log4j_re.match(line) or self.log4j_thread_first_re.match(line)
        if not match:
            return None
        values = match.groupdict()
        timestamp, inferred = parse_timestamp(values.get("timestamp"))
        if timestamp is None:
            return None
        return {
            "timestamp": timestamp,
            "timestamp_raw": str(values.get("timestamp") or ""),
            "timestamp_inferred": inferred,
            "level": values.get("level"),
            "message": str(values.get("message") or ""),
            "thread": str(values.get("thread") or ""),
            "logger": str(values.get("logger") or "").strip(),
            "process_id": str(values.get("pid") or ""),
            "attributes": {"logging_context": values.get("context")} if values.get("context") else {},
        }


class JsonLogParser(LogParser):
    name = "json"
    timestamp_aliases = ("@timestamp", "timestamp", "time", "ts", "datetime", "event.created")
    level_aliases = ("level", "log.level", "severity", "severitytext", "loglevel")
    message_aliases = ("message", "msg", "log", "event.original", "body")
    service_aliases = ("service.name", "service", "app", "application", "spring.application.name")

    def probe(self, lines: list[str]) -> float:
        nonempty = [line.strip() for line in lines if line.strip()]
        if not nonempty:
            return 0.0
        matched = 0
        for line in nonempty:
            if line.startswith("{"):
                try:
                    matched += int(isinstance(json.loads(line), dict))
                except (json.JSONDecodeError, TypeError):
                    pass
        return matched / len(nonempty)

    def parse(self, lines: list[str], source_path: Path, source_file: str, confidence: float) -> FileParseResult:
        result = FileParseResult(parser_name=self.name, parser_confidence=confidence, total_lines=len(lines))
        spring = SpringJavaParser()
        for line_number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                result.unparsed.append(UnparsedRecord(source_file, line_number, line_number, line, "invalid_json", self.name))
                continue
            if not isinstance(payload, dict):
                result.unparsed.append(UnparsedRecord(source_file, line_number, line_number, line, "json_value_is_not_object", self.name))
                continue
            flat = _flatten(payload)
            message = _json_text(_pick(flat, self.message_aliases)).rstrip("\r\n")
            timestamp_value = _pick(flat, self.timestamp_aliases)
            timestamp, inferred = parse_timestamp(timestamp_value)
            inner = spring.parse_header(message)
            if timestamp is None and inner:
                timestamp = inner["timestamp"]
                timestamp_value = inner["timestamp_raw"]
                inferred = bool(inner.get("timestamp_inferred"))
            if timestamp is None:
                result.unparsed.append(UnparsedRecord(
                    source_file, line_number, line_number, line,
                    "json_event_has_no_supported_timestamp", self.name,
                ))
                continue
            level = _pick(flat, self.level_aliases) or (inner or {}).get("level") or (
                "ERROR" if str(payload.get("stream") or "").lower() == "stderr" else "INFO"
            )
            if inner:
                message = str(inner.get("message") or message)
            stack = _json_text(_pick(flat, (
                "exception.stacktrace", "exception.stack_trace", "stack_trace", "stacktrace", "error.stack",
            )))
            continuation = stack.splitlines() if stack else message.splitlines()[1:]
            if "\n" in message:
                message = message.splitlines()[0]
            result.events.append(build_event(
                timestamp=timestamp,
                timestamp_raw=str(timestamp_value),
                timestamp_inferred=inferred,
                level=level,
                message=message,
                continuation=continuation,
                source_path=source_path,
                source_file=source_file,
                start_line=line_number,
                end_line=line_number,
                parser_name=self.name,
                confidence=confidence,
                service=_json_text(_pick(flat, self.service_aliases)),
                instance=_json_text(_pick(flat, ("service.instance.id", "instance", "pod_name", "kubernetes.pod.name"))),
                thread=_json_text(_pick(flat, ("thread", "thread_name", "thread.name"))) or str((inner or {}).get("thread") or ""),
                logger=_json_text(_pick(flat, ("logger", "logger_name", "log.logger"))) or str((inner or {}).get("logger") or ""),
                process_id=_json_text(_pick(flat, ("process.pid", "pid"))) or str((inner or {}).get("process_id") or ""),
                host=_json_text(_pick(flat, ("host.name", "hostname", "host"))),
                namespace=_json_text(_pick(flat, ("kubernetes.namespace", "kubernetes.namespace_name", "namespace"))),
                container=_json_text(_pick(flat, ("container.name", "container", "kubernetes.container.name"))),
                attributes=payload,
                raw_block=line,
                trace_id_hint=_json_text(_pick(flat, ("trace.id", "trace_id", "traceid"))),
                span_id_hint=_json_text(_pick(flat, ("span.id", "span_id", "spanid"))),
                request_id_hint=_json_text(_pick(flat, ("request.id", "request_id", "requestid", "correlation_id"))),
            ))
        return result


class CriLogParser(LogParser):
    name = "kubernetes_cri"
    header_re = re.compile(r"^(?P<timestamp>\S+)\s+(?P<stream>stdout|stderr)\s+(?P<tag>[FP])\s(?P<message>.*)$")

    def probe(self, lines: list[str]) -> float:
        nonempty = [line for line in lines if line.strip()]
        return 0.0 if not nonempty else sum(bool(self.header_re.match(line)) for line in nonempty) / len(nonempty)

    def parse(self, lines: list[str], source_path: Path, source_file: str, confidence: float) -> FileParseResult:
        result = FileParseResult(parser_name=self.name, parser_confidence=confidence, total_lines=len(lines))
        spring = SpringJavaParser()
        partial: list[str] = []
        partial_start = 0
        partial_timestamp = ""
        partial_stream = "stdout"

        def emit(message: str, start: int, end: int, raw_timestamp: str, stream: str) -> None:
            timestamp, inferred = parse_timestamp(raw_timestamp)
            inner = spring.parse_header(message)
            if timestamp is None and inner:
                timestamp = inner["timestamp"]
                raw_timestamp = inner["timestamp_raw"]
            if timestamp is None:
                result.unparsed.append(UnparsedRecord(
                    source_file, start, end, message, "cri_event_has_no_supported_timestamp", self.name,
                ))
                return
            header = inner or {}
            inner_message = str(header.get("message") or message)
            parts = inner_message.splitlines()
            result.events.append(build_event(
                timestamp=timestamp,
                timestamp_raw=raw_timestamp,
                timestamp_inferred=inferred,
                level=header.get("level") or ("ERROR" if stream == "stderr" else "INFO"),
                message=parts[0] if parts else "",
                continuation=parts[1:],
                source_path=source_path,
                source_file=source_file,
                start_line=start,
                end_line=end,
                parser_name=self.name,
                confidence=confidence,
                thread=str(header.get("thread") or ""),
                logger=str(header.get("logger") or ""),
                process_id=str(header.get("process_id") or ""),
                attributes={"stream": stream, "wrapped_parser": "spring_java" if inner else "plain"},
                raw_block=message,
            ))

        for line_number, line in enumerate(lines, start=1):
            match = self.header_re.match(line)
            if not match:
                result.unparsed.append(UnparsedRecord(source_file, line_number, line_number, line, "invalid_cri_line", self.name))
                continue
            values = match.groupdict()
            if values["tag"] == "P":
                if not partial:
                    partial_start = line_number
                    partial_timestamp = values["timestamp"]
                    partial_stream = values["stream"]
                partial.append(values["message"])
                continue
            if partial:
                partial.append(values["message"])
                emit("".join(partial), partial_start, line_number, partial_timestamp, partial_stream)
                partial = []
            else:
                emit(values["message"], line_number, line_number, values["timestamp"], values["stream"])
        if partial:
            result.unparsed.append(UnparsedRecord(
                source_file, partial_start, len(lines), "".join(partial), "unterminated_cri_partial_event", self.name,
            ))
        return result


class LogfmtParser(LogParser):
    name = "logfmt"
    pair_re = re.compile(r"(?:^|\s)([A-Za-z_][\w.-]*)=(?:\"(?:\\.|[^\"])*\"|'(?:\\.|[^'])*'|\S+)")

    @staticmethod
    def _pairs(line: str) -> dict[str, str]:
        result: dict[str, str] = {}
        try:
            tokens = shlex.split(line, posix=True)
        except ValueError:
            tokens = line.split()
        for token in tokens:
            if "=" in token:
                key, value = token.split("=", 1)
                if key:
                    result[key] = value
        return result

    def probe(self, lines: list[str]) -> float:
        nonempty = [line for line in lines if line.strip()]
        return 0.0 if not nonempty else sum(len(self.pair_re.findall(line)) >= 2 for line in nonempty) / len(nonempty) * 0.9

    def parse(self, lines: list[str], source_path: Path, source_file: str, confidence: float) -> FileParseResult:
        result = FileParseResult(parser_name=self.name, parser_confidence=confidence, total_lines=len(lines))
        for line_number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            pairs = self._pairs(line)
            lowered = {key.lower(): value for key, value in pairs.items()}
            timestamp_value = next((lowered[key] for key in ("timestamp", "time", "ts", "datetime", "@timestamp") if key in lowered), "")
            timestamp, inferred = parse_timestamp(timestamp_value)
            if timestamp is None:
                result.unparsed.append(UnparsedRecord(
                    source_file, line_number, line_number, line, "logfmt_event_has_no_supported_timestamp", self.name,
                ))
                continue
            message = next((lowered[key] for key in ("message", "msg", "event", "log") if key in lowered), line)
            result.events.append(build_event(
                timestamp=timestamp,
                timestamp_raw=timestamp_value,
                timestamp_inferred=inferred,
                level=lowered.get("level") or lowered.get("severity") or "INFO",
                message=message,
                continuation=[],
                source_path=source_path,
                source_file=source_file,
                start_line=line_number,
                end_line=line_number,
                parser_name=self.name,
                confidence=confidence,
                service=lowered.get("service") or lowered.get("app") or lowered.get("application") or "",
                instance=lowered.get("instance") or lowered.get("pod") or "",
                thread=lowered.get("thread") or "",
                logger=lowered.get("logger") or "",
                process_id=lowered.get("pid") or "",
                host=lowered.get("host") or lowered.get("hostname") or "",
                container=lowered.get("container") or "",
                namespace=lowered.get("namespace") or "",
                attributes=pairs,
                raw_block=line,
                trace_id_hint=lowered.get("trace_id") or lowered.get("traceid") or "",
                span_id_hint=lowered.get("span_id") or lowered.get("spanid") or "",
                request_id_hint=lowered.get("request_id") or lowered.get("requestid") or lowered.get("correlation_id") or "",
            ))
        return result


class NginxAccessParser(LogParser):
    name = "nginx_access"
    access_re = re.compile(
        r'^(?P<remote>\S+)\s+\S+\s+\S+\s+\[(?P<timestamp>[^\]]+)\]\s+'
        r'"(?P<request>[^\"]*)"\s+(?P<status>\d{3})\s+(?P<bytes>\S+)'
        r'(?:\s+"(?P<referer>[^\"]*)"\s+"(?P<agent>[^\"]*)")?.*$'
    )

    def probe(self, lines: list[str]) -> float:
        nonempty = [line for line in lines if line.strip()]
        return 0.0 if not nonempty else sum(bool(self.access_re.match(line)) for line in nonempty) / len(nonempty)

    def parse(self, lines: list[str], source_path: Path, source_file: str, confidence: float) -> FileParseResult:
        result = FileParseResult(parser_name=self.name, parser_confidence=confidence, total_lines=len(lines))
        for line_number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            match = self.access_re.match(line)
            if not match:
                result.unparsed.append(UnparsedRecord(source_file, line_number, line_number, line, "invalid_nginx_access_line", self.name))
                continue
            values = match.groupdict()
            timestamp, inferred = parse_timestamp(values["timestamp"])
            if timestamp is None:
                result.unparsed.append(UnparsedRecord(source_file, line_number, line_number, line, "invalid_nginx_timestamp", self.name))
                continue
            status = int(values["status"])
            level = "ERROR" if status >= 500 else "WARN" if status >= 400 else "INFO"
            result.events.append(build_event(
                timestamp=timestamp,
                timestamp_raw=values["timestamp"],
                timestamp_inferred=inferred,
                level=level,
                message=f"{values['request']} status={status}",
                continuation=[],
                source_path=source_path,
                source_file=source_file,
                start_line=line_number,
                end_line=line_number,
                parser_name=self.name,
                confidence=confidence,
                attributes={
                    "remote_addr": values["remote"], "request": values["request"],
                    "status": status, "bytes": values["bytes"],
                    "referer": values.get("referer") or "", "user_agent": values.get("agent") or "",
                },
                raw_block=line,
            ))
        return result


class SyslogParser(LogParser):
    name = "syslog"
    rfc5424_re = re.compile(
        r"^<(?P<priority>\d{1,3})>\d+\s+(?P<timestamp>\S+)\s+(?P<host>\S+)\s+"
        r"(?P<app>\S+)\s+(?P<pid>\S+)\s+(?P<msgid>\S+)\s+(?:-|\[[^\]]*\])\s*(?P<message>.*)$"
    )
    rfc3164_re = re.compile(
        r"^(?P<timestamp>[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+"
        r"(?P<host>\S+)\s+(?P<app>[\w./-]+)(?:\[(?P<pid>\d+)\])?:\s*(?P<message>.*)$"
    )

    def probe(self, lines: list[str]) -> float:
        nonempty = [line for line in lines if line.strip()]
        return 0.0 if not nonempty else sum(bool(self.rfc5424_re.match(line) or self.rfc3164_re.match(line)) for line in nonempty) / len(nonempty)

    @staticmethod
    def _priority_level(priority: str) -> str:
        severity = int(priority) % 8
        if severity <= 2:
            return "FATAL"
        if severity == 3:
            return "ERROR"
        if severity == 4:
            return "WARN"
        if severity in {5, 6}:
            return "INFO"
        return "DEBUG"

    def parse(self, lines: list[str], source_path: Path, source_file: str, confidence: float) -> FileParseResult:
        result = FileParseResult(parser_name=self.name, parser_confidence=confidence, total_lines=len(lines))
        for line_number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            match = self.rfc5424_re.match(line)
            inferred = False
            if match:
                values = match.groupdict()
                timestamp, _ = parse_timestamp(values["timestamp"])
                level = self._priority_level(values["priority"])
            else:
                match = self.rfc3164_re.match(line)
                if not match:
                    result.unparsed.append(UnparsedRecord(source_file, line_number, line_number, line, "invalid_syslog_line", self.name))
                    continue
                values = match.groupdict()
                try:
                    timestamp = datetime.strptime(f"{datetime.now().year} {values['timestamp']}", "%Y %b %d %H:%M:%S")
                    inferred = True
                except ValueError:
                    timestamp = None
                level = "INFO"
            if timestamp is None:
                result.unparsed.append(UnparsedRecord(source_file, line_number, line_number, line, "invalid_syslog_timestamp", self.name))
                continue
            result.events.append(build_event(
                timestamp=timestamp,
                timestamp_raw=values["timestamp"],
                timestamp_inferred=inferred,
                level=level,
                message=values["message"],
                continuation=[],
                source_path=source_path,
                source_file=source_file,
                start_line=line_number,
                end_line=line_number,
                parser_name=self.name,
                confidence=confidence,
                service=values.get("app") or "",
                host=values.get("host") or "",
                process_id=values.get("pid") or "",
                attributes={key: value for key, value in values.items() if key != "message"},
                warnings=["timestamp_year_inferred"] if inferred else [],
                raw_block=line,
            ))
        return result


class GenericTextParser(HeaderBlockParser):
    name = "generic_text"
    generic_re = re.compile(
        rf"^(?P<timestamp>{TIMESTAMP_TOKEN})\s+.*?\b(?P<level>{LEVEL_TOKEN})\b[\s:|\]-]*(?P<message>.*)$",
        re.IGNORECASE,
    )

    def probe(self, lines: list[str]) -> float:
        return super().probe(lines) * 0.55

    def parse_header(self, line: str) -> dict[str, Any] | None:
        match = self.generic_re.match(line)
        if not match:
            return None
        values = match.groupdict()
        timestamp, inferred = parse_timestamp(values["timestamp"])
        if timestamp is None:
            return None
        return {
            "timestamp": timestamp,
            "timestamp_raw": values["timestamp"],
            "timestamp_inferred": inferred,
            "level": values["level"],
            "message": values["message"] or line[match.end("level") :].lstrip(" :-|]"),
            "warnings": ["generic_parser_used"],
        }


class ParserRegistry:
    def __init__(self, parsers: list[LogParser] | None = None, *, max_event_lines: int = 2000) -> None:
        self.parsers = parsers or [
            JsonLogParser(), CriLogParser(), SpringJavaParser(), NginxAccessParser(),
            SyslogParser(), LogfmtParser(), GenericTextParser(),
        ]
        for parser in self.parsers:
            if isinstance(parser, HeaderBlockParser):
                parser.max_event_lines = max(2, int(max_event_lines))

    def detect(self, lines: list[str], sample_size: int = 200) -> tuple[LogParser, float, list[tuple[str, float]]]:
        nonempty = [line for line in lines if line.strip()]
        if len(nonempty) > sample_size:
            head_count = sample_size // 2
            sample = nonempty[:head_count] + nonempty[-(sample_size - head_count):]
        else:
            sample = nonempty
        scores = [(parser, float(parser.probe(sample))) for parser in self.parsers]
        scores.sort(key=lambda item: item[1], reverse=True)
        parser, score = scores[0]
        return parser, score, [(item.name, round(value, 4)) for item, value in scores]

    def parse(
        self,
        lines: list[str],
        source_path: Path,
        source_file: str,
        *,
        sample_size: int = 200,
        minimum_confidence: float = 0.1,
    ) -> tuple[FileParseResult, list[tuple[str, float]]]:
        parser, confidence, scores = self.detect(lines, sample_size=sample_size)
        if confidence < minimum_confidence:
            return FileParseResult(
                unparsed=[UnparsedRecord(
                    source_file, 1, len(lines), "\n".join(lines),
                    "no_parser_reached_minimum_confidence",
                )],
                parser_name="unrecognized",
                parser_confidence=confidence,
                total_lines=len(lines),
            ), scores
        return parser.parse(lines, source_path, source_file, confidence), scores
