from __future__ import annotations

import fnmatch
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
TRACE_PREFIX_RE = re.compile(r"^\[(?P<trace>[0-9a-fA-F]{8,32})\]\s*(?P<message>.*)$")
EXCEPTION_RE = re.compile(r"^(?:Caused by:\s*)?(?P<class>[\w.$]+(?:Exception|Error))(?::\s*(?P<message>.*))?$")
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
    raw_block: str
    source_file: str
    source_line: int


def _matches_any(path: str, patterns: list[str]) -> bool:
    normalized = path.replace("\\", "/")
    for pattern in patterns:
        if fnmatch.fnmatch(normalized, pattern):
            return True
        # Python fnmatch 对根目录直接文件不会把 **/ 当成零级目录处理。
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

def _parse_exception_details(continuation_lines: list[str]) -> tuple[str, str, str]:
    exceptions: list[tuple[str, str]] = []
    for line in continuation_lines:
        stripped = line.strip()
        match = EXCEPTION_RE.match(stripped)
        if match:
            exceptions.append((match.group("class") or "", match.group("message") or ""))
    if not exceptions:
        return "", "", ""
    first_class = exceptions[0][0]
    root_class, root_message = exceptions[-1]
    root_cause = f"{root_class}: {root_message}".rstrip(": ")
    return first_class, root_class, root_cause


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
        exception_class, root_exception_class, root_cause = _parse_exception_details(continuation)
        semantic_parts = [first_message]
        if exception_class:
            semantic_parts.append(exception_class)
        if root_cause and root_cause != exception_class:
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
            raw_block="\n".join(item["raw_lines"]),
            source_file=str(path),
            source_line=item["source_line"],
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


def load_events(input_path: str | Path, input_config: dict) -> pd.DataFrame:
    source = Path(input_path)
    temp_dir: tempfile.TemporaryDirectory[str] | None = None
    try:
        if source.is_file() and source.suffix.lower() == ".zip":
            temp_dir = tempfile.TemporaryDirectory(prefix="logfault-")
            with zipfile.ZipFile(source, "r") as archive:
                archive.extractall(temp_dir.name)
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
