from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class ParsedEvent:
    """Stable event contract shared by every log-format parser."""

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
    source_line_end: int = 0
    timestamp_raw: str = ""
    timestamp_inferred: bool = False
    level_raw: str = ""
    span_id: str = ""
    request_id: str = ""
    host: str = ""
    namespace: str = ""
    container: str = ""
    process_id: str = ""
    attributes: str = "{}"
    parser_name: str = ""
    parser_version: str = "1"
    parse_confidence: float = 1.0
    parse_warnings: str = "[]"


@dataclass
class UnparsedRecord:
    source_file: str
    start_line: int
    end_line: int
    raw_text: str
    reason: str
    parser_name: str = ""


@dataclass
class FileParseResult:
    events: list[ParsedEvent] = field(default_factory=list)
    unparsed: list[UnparsedRecord] = field(default_factory=list)
    parser_name: str = ""
    parser_confidence: float = 0.0
    encoding: str = ""
    total_lines: int = 0
