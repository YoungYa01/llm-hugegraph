from __future__ import annotations

import fnmatch
import json
import re
import tempfile
import zipfile
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterator

import pandas as pd


LOG_START_RE = re.compile(
    r"^(?P<timestamp>(?:\d{2}/\d{2}/\d{2}|\d{4}[-/]\d{2}[-/]\d{2})\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+"
    r"(?P<level>TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+---\s+"
    r"\[(?P<thread>[^\]]+)\]\s+"
    r"(?P<logger>.*?)\s*:\s*(?P<message>.*)$"
)
TRACE_PREFIX_RE = re.compile(r"^\[(?P<trace>[A-Za-z0-9_.-]{4,64})\]\s*(?P<message>.*)$")
INLINE_TRACE_RE = re.compile(
    r"(?i)\b(?:trace_?id|request_?id|req_?id|uuid|span_?id|correlation_?id)\s*[=:]\s*['\"]?([A-Za-z0-9_.-]{4,64})['\"]?"
)
DOWNSTREAM_RE = re.compile(
    r"(?i)\b(?:downstream|target\s+physical\s+host|target\s+host|target_?service|calling\s+downstream\s+service)\s*[=:]\s*['\"]?([A-Za-z0-9_.-]{2,64})['\"]?"
)
EXCEPTION_CLASS_RE = re.compile(r"(?P<class>[A-Za-z_$][\w.$]*(?:Exception|Error))\b")
EXCEPTION_HEADER_RE = re.compile(
    r"^(?:(?P<prefix>Caused by|Suppressed)\s*:\s*)?"
    r"(?P<class>[A-Za-z_$][\w.$]*(?:Exception|Error))"
    r"(?::\s*(?P<message>.*))?$",
    re.IGNORECASE,
)
PORT_SUFFIX_RE = re.compile(r"-\d+$")


@dataclass
class ParsedEvent:
    timestamp: datetime
    level: str
    service: str
    instance: str
    thread: str
    logger: str
    trace_id: str
    message: str
    semantic_message: str
    exception_class: str
    root_exception_class: str
    root_cause: str
    exception_chain: str
    raw_block: str
    source_file: str
    source_line: int
    downstream_target: str = ""


def _matches_any(path: str, patterns: list[str]) -> bool:
    normalized = path.replace("\\", "/")
    for pattern in patterns:
        if fnmatch.fnmatch(normalized, pattern):
            return True
        if pattern.startswith("**/") and fnmatch.fnmatch(normalized, pattern[3:]):
            return True
    return False


def _service_from_file(path: Path) -> str:
    stem = path.stem
    stem = re.sub(r"-(?:err|debug)$", "", stem)
    service = PORT_SUFFIX_RE.sub("", stem)
    return service or path.parent.name


def _instance_from_path(path: Path) -> str:
    return path.parent.name


def discover_log_files(root: Path, include_globs: list[str], exclude_globs: list[str]) -> list[Path]:
    if root.is_file() and root.suffix.lower() == ".log":
        return [root]
    if not root.is_dir():
        raise ValueError(f"输入必须是 .log 文件、目录或 ZIP: {root}")

    files: list[Path] = []
    for candidate in root.rglob("*.log"):
        relative = candidate.relative_to(root).as_posix()
        if include_globs and not _matches_any(relative, include_globs):
            continue
        if exclude_globs and _matches_any(relative, exclude_globs):
            continue
        files.append(candidate)
    return sorted(files)


def _parse_timestamp(value: str) -> datetime:
    formats = (
        "%y/%m/%d %H:%M:%S.%f",
        "%Y-%m-%d %H:%M:%S.%f",
        "%Y/%m/%d %H:%M:%S.%f",
    )
    for fmt in formats:
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    raise ValueError(f"不支持的日志时间格式: {value}")


def _exception_entry(line: str, *, first_message: bool = False) -> dict[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("at ") or stripped.startswith("... "):
        return None

    header = EXCEPTION_HEADER_RE.match(stripped)
    if header:
        prefix = str(header.group("prefix") or "").lower()
        kind = "caused_by" if prefix == "caused by" else "suppressed" if prefix == "suppressed" else "direct"
        return {
            "class": str(header.group("class") or ""),
            "message": str(header.group("message") or ""),
            "kind": kind,
        }

    # 常见包装文本："nested exception is ..."、"failed: java.x.Exception: ..."。
    # 只在首行、Caused by/Suppressed 行或明确包含 exception is 的行中搜索，
    # 避免把普通业务文本里提到的类名误判为异常栈头。
    lowered = stripped.lower()
    eligible = first_message or lowered.startswith(("caused by:", "suppressed:")) or "exception is" in lowered
    if not eligible:
        return None
    token = EXCEPTION_CLASS_RE.search(stripped)
    if not token:
        return None
    class_name = str(token.group("class") or "")
    remainder = stripped[token.end() :].lstrip(": ")
    kind = "caused_by" if lowered.startswith("caused by:") else "suppressed" if lowered.startswith("suppressed:") else "direct"
    return {"class": class_name, "message": remainder, "kind": kind}


def _parse_exception_details(first_message: str, continuation_lines: list[str]) -> tuple[str, str, str, str]:
    entries: list[dict[str, str]] = []
    first_entry = _exception_entry(first_message, first_message=True)
    if first_entry:
        entries.append(first_entry)
    for line in continuation_lines:
        entry = _exception_entry(line)
        if entry:
            entries.append(entry)

    if not entries:
        return "", "", "", "[]"

    non_suppressed = [entry for entry in entries if entry["kind"] != "suppressed"] or entries
    first_class = non_suppressed[0]["class"]
    caused = [entry for entry in non_suppressed if entry["kind"] == "caused_by"]
    root = caused[-1] if caused else non_suppressed[-1]
    root_class = root["class"]
    root_message = root["message"]
    root_cause = f"{root_class}: {root_message}".rstrip(": ")
    chain = json.dumps(entries, ensure_ascii=False)
    return first_class, root_class, root_cause, chain


def parse_log_file(path: Path, encoding: str = "utf-8", errors: str = "replace") -> Iterator[ParsedEvent]:
    service = _service_from_file(path)
    instance = _instance_from_path(path)
    current: dict | None = None

    def emit(item: dict | None) -> ParsedEvent | None:
        if item is None:
            return None
        first_message = item["message"]
        trace_id = ""
        trace_match = TRACE_PREFIX_RE.match(first_message)
        if trace_match:
            trace_id = trace_match.group("trace")
            first_message = trace_match.group("message")

        continuation = item["continuation"]
        raw_text = "\n".join([first_message, *continuation])

        if not trace_id:
            inline_match = INLINE_TRACE_RE.search(raw_text)
            if inline_match:
                trace_id = inline_match.group(1)

        downstream_target = ""
        downstream_match = DOWNSTREAM_RE.search(raw_text)
        if downstream_match:
            downstream_target = downstream_match.group(1)

        exception_class, root_exception_class, root_cause, exception_chain = _parse_exception_details(
            first_message, continuation
        )
        semantic_parts = [first_message]
        if exception_class and exception_class not in first_message:
            semantic_parts.append(exception_class)
        if root_cause and root_cause not in first_message and root_cause != exception_class:
            semantic_parts.append(root_cause)
        semantic_message = " | ".join(part for part in semantic_parts if part)

        return ParsedEvent(
            timestamp=item["timestamp"],
            level=item["level"],
            service=service,
            instance=instance,
            thread=item["thread"],
            logger=item["logger"],
            trace_id=trace_id,
            message=first_message,
            semantic_message=semantic_message,
            exception_class=exception_class,
            root_exception_class=root_exception_class,
            root_cause=root_cause,
            exception_chain=exception_chain,
            raw_block="\n".join(item["raw_lines"]),
            source_file=str(path),
            source_line=item["source_line"],
            downstream_target=downstream_target,
        )

    with path.open("r", encoding=encoding, errors=errors) as handle:
        for line_number, raw in enumerate(handle, start=1):
            line = raw.rstrip("\r\n")
            match = LOG_START_RE.match(line)
            if match:
                event = emit(current)
                if event is not None:
                    yield event
                current = {
                    "timestamp": _parse_timestamp(match.group("timestamp")),
                    "level": match.group("level"),
                    "thread": match.group("thread"),
                    "logger": match.group("logger").strip(),
                    "message": match.group("message"),
                    "continuation": [],
                    "raw_lines": [line],
                    "source_line": line_number,
                }
            elif current is not None:
                current["continuation"].append(line)
                current["raw_lines"].append(line)

    event = emit(current)
    if event is not None:
        yield event


def _safe_extract_zip(archive: zipfile.ZipFile, destination: Path) -> None:
    root = destination.resolve()
    for item in archive.infolist():
        target = (root / item.filename).resolve()
        if not target.is_relative_to(root):
            raise ValueError("ZIP 包含不安全的目录路径")
        archive.extract(item, root)


def load_events(input_path: str | Path, input_config: dict) -> pd.DataFrame:
    source = Path(input_path)
    temp_dir: tempfile.TemporaryDirectory[str] | None = None
    try:
        if source.is_file() and source.suffix.lower() == ".zip":
            temp_dir = tempfile.TemporaryDirectory(prefix="logfault-")
            with zipfile.ZipFile(source, "r") as archive:
                _safe_extract_zip(archive, Path(temp_dir.name))
            root = Path(temp_dir.name)
        else:
            root = source

        files = discover_log_files(
            root,
            input_config.get("include_globs", ["**/*.log"]),
            input_config.get("exclude_globs", []),
        )
        if not files:
            raise ValueError("没有找到符合条件的 .log 文件")

        records = []
        for file_path in files:
            try:
                logical_source = file_path.relative_to(root).as_posix()
            except ValueError:
                logical_source = file_path.name
            for event in parse_log_file(
                file_path,
                encoding=input_config.get("encoding", "utf-8"),
                errors=input_config.get("encoding_errors", "replace"),
            ):
                record = asdict(event)
                record["source_file"] = logical_source
                record["event_id"] = f"{logical_source}:{event.source_line}"
                records.append(record)

        if not records:
            raise ValueError("找到日志文件，但没有解析出符合 Spring 格式的日志事件")
        frame = pd.DataFrame.from_records(records)
        frame["timestamp"] = pd.to_datetime(frame["timestamp"])
        frame = frame.sort_values(["timestamp", "source_file", "source_line"]).reset_index(drop=True)
        return frame
    finally:
        if temp_dir is not None:
            temp_dir.cleanup()
