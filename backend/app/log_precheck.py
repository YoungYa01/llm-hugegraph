from __future__ import annotations

import io
import re
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any, Iterator, TextIO


TIMESTAMP_RE = re.compile(
    r"^(?P<timestamp>(?:\d{2}/\d{2}/\d{2}|\d{4}[-/]\d{2}[-/]\d{2})\s+\d{2}:\d{2}:\d{2}\.\d{3})(?:\s+|$)"
)
LEVEL_RE = re.compile(r"\b(?P<level>TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b")
TIMESTAMP_FORMATS = (
    "%y/%m/%d %H:%M:%S.%f",
    "%Y-%m-%d %H:%M:%S.%f",
    "%Y/%m/%d %H:%M:%S.%f",
)
SUPPORTED_SUFFIXES = {".log", ".txt"}


def _iso(value: datetime | None) -> str:
    return value.isoformat(timespec="milliseconds") if value else ""


def _parse_timestamp(value: str) -> datetime | None:
    for fmt in TIMESTAMP_FORMATS:
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def _safe_zip_members(
    archive: zipfile.ZipFile,
    *,
    max_uncompressed_bytes: int,
    max_files: int,
) -> list[zipfile.ZipInfo]:
    members: list[zipfile.ZipInfo] = []
    total_size = 0
    for item in archive.infolist():
        if item.is_dir():
            continue
        normalized = PurePosixPath(item.filename.replace("\\", "/"))
        if normalized.is_absolute() or ".." in normalized.parts:
            raise ValueError("ZIP 包含不安全的目录路径")
        if normalized.suffix.lower() not in SUPPORTED_SUFFIXES:
            continue
        members.append(item)
        total_size += max(0, int(item.file_size))
        if len(members) > max_files:
            raise ValueError(f"ZIP 中日志文件超过 {max_files} 个限制")
        if total_size > max_uncompressed_bytes:
            size_mb = max_uncompressed_bytes // (1024 * 1024)
            raise ValueError(f"ZIP 解压后的日志数据超过 {size_mb} MB 限制")
        if item.file_size > 10 * 1024 * 1024 and item.compress_size > 0:
            if item.file_size / item.compress_size > 500:
                raise ValueError(f"ZIP 文件 {item.filename} 压缩比异常，已拒绝处理")
    if not members:
        raise ValueError("没有找到可预检的 .log 或 .txt 日志文件")
    return members


def _open_sources(
    input_path: Path,
    *,
    max_uncompressed_bytes: int,
    max_files: int,
) -> Iterator[tuple[str, TextIO]]:
    suffix = input_path.suffix.lower()
    if suffix in SUPPORTED_SUFFIXES:
        with input_path.open("r", encoding="utf-8", errors="replace") as handle:
            yield input_path.name, handle
        return
    if suffix != ".zip":
        raise ValueError("只支持 .log、.txt 或 .zip 日志文件")

    with zipfile.ZipFile(input_path, "r") as archive:
        for member in _safe_zip_members(
            archive,
            max_uncompressed_bytes=max_uncompressed_bytes,
            max_files=max_files,
        ):
            with archive.open(member, "r") as raw:
                with io.TextIOWrapper(raw, encoding="utf-8", errors="replace") as handle:
                    yield member.filename.replace("\\", "/"), handle


def _segment_buckets(
    buckets: dict[datetime, dict[str, Any]],
    *,
    gap_hours: int,
) -> list[dict[str, Any]]:
    ordered = sorted(buckets)
    if not ordered:
        return []
    groups: list[list[datetime]] = [[ordered[0]]]
    for bucket in ordered[1:]:
        if bucket - groups[-1][-1] > timedelta(hours=gap_hours):
            groups.append([bucket])
        else:
            groups[-1].append(bucket)
    return [
        {
            "start_time": _iso(buckets[group[0]]["first"]),
            "end_time": _iso(buckets[group[-1]]["last"]),
            "events": sum(buckets[item]["events"] for item in group),
            "errors": sum(buckets[item]["errors"] for item in group),
        }
        for group in groups
    ]


def precheck_log_input(
    input_path: str | Path,
    *,
    max_uncompressed_mb: int = 1000,
    max_files: int = 2000,
    confirmation_hours: int = 24,
    segment_gap_hours: int = 6,
) -> dict[str, Any]:
    """Stream log headers and return a time-range decision without running RCA."""

    source = Path(input_path)
    earliest: datetime | None = None
    latest: datetime | None = None
    total_lines = 0
    candidate_lines = 0
    timestamped_events = 0
    invalid_timestamp_lines = 0
    severity_counts: dict[str, int] = defaultdict(int)
    buckets: dict[datetime, dict[str, Any]] = defaultdict(
        lambda: {"events": 0, "errors": 0, "first": None, "last": None}
    )
    source_files: list[str] = []

    for source_name, handle in _open_sources(
        source,
        max_uncompressed_bytes=max(1, max_uncompressed_mb) * 1024 * 1024,
        max_files=max_files,
    ):
        source_files.append(source_name)
        for raw_line in handle:
            total_lines += 1
            line = raw_line.rstrip("\r\n")
            level_match = LEVEL_RE.search(line)
            if level_match:
                candidate_lines += 1
            timestamp_match = TIMESTAMP_RE.match(line)
            if not timestamp_match:
                continue
            timestamp = _parse_timestamp(timestamp_match.group("timestamp"))
            if timestamp is None:
                invalid_timestamp_lines += 1
                continue
            timestamped_events += 1
            earliest = timestamp if earliest is None or timestamp < earliest else earliest
            latest = timestamp if latest is None or timestamp > latest else latest
            level = level_match.group("level") if level_match else "UNKNOWN"
            severity_counts[level] += 1
            hour = timestamp.replace(minute=0, second=0, microsecond=0)
            bucket = buckets[hour]
            bucket["events"] += 1
            bucket["first"] = (
                timestamp if bucket["first"] is None or timestamp < bucket["first"] else bucket["first"]
            )
            bucket["last"] = (
                timestamp if bucket["last"] is None or timestamp > bucket["last"] else bucket["last"]
            )
            if level in {"ERROR", "FATAL"}:
                bucket["errors"] += 1

    if timestamped_events == 0:
        return {
            "detected_start_time": "",
            "detected_end_time": "",
            "duration_hours": 0,
            "timestamp_parse_rate": 0,
            "total_lines": total_lines,
            "timestamped_events": 0,
            "invalid_timestamp_lines": invalid_timestamp_lines,
            "source_files": source_files,
            "severity_counts": dict(severity_counts),
            "segments": [],
            "recommended_start_time": "",
            "recommended_end_time": "",
            "requires_confirmation": True,
            "can_select_time_range": False,
            "warnings": ["未识别到符合当前 Spring 日志格式的时间戳，无法自动限定分析时间范围"],
            "reason": "timestamp_not_detected",
        }

    assert earliest is not None and latest is not None
    duration_hours = max(0.0, (latest - earliest).total_seconds() / 3600)
    parse_rate = timestamped_events / max(1, candidate_lines, timestamped_events)
    segments = _segment_buckets(buckets, gap_hours=segment_gap_hours)
    future_detected = latest > datetime.now() + timedelta(days=1)
    warnings: list[str] = []
    if duration_hours > confirmation_hours:
        warnings.append(f"日志时间跨度为 {duration_hours:.1f} 小时，超过 {confirmation_hours} 小时自动分析阈值")
    if duration_hours > 24 * 7:
        warnings.append("日志跨度超过 7 天，建议拆分为多个独立分析批次")
    if len(segments) > 1:
        warnings.append(f"检测到 {len(segments)} 个相互间隔超过 {segment_gap_hours} 小时的日志时间段")
    if earliest.year != latest.year:
        warnings.append("日志跨越不同年份，可能混入历史日志")
    if future_detected:
        warnings.append("检测到晚于当前时间一天以上的日志，请检查机器时钟或日志年份")
    if parse_rate < 0.6:
        warnings.append(f"时间戳识别率仅为 {parse_rate:.0%}，推荐时间范围可信度较低")

    if any(item["errors"] for item in buckets.values()):
        peak = max(buckets, key=lambda item: (buckets[item]["errors"], buckets[item]["events"], item))
        recommended_start = max(earliest, peak - timedelta(minutes=15))
        recommended_end = min(latest, peak + timedelta(hours=1, minutes=10))
    else:
        recommended_end = latest
        recommended_start = max(earliest, latest - timedelta(hours=confirmation_hours))
    if recommended_end <= recommended_start:
        recommended_end = latest
        recommended_start = earliest

    requires_confirmation = bool(
        duration_hours > confirmation_hours
        or len(segments) > 1
        or future_detected
        or parse_rate < 0.6
    )
    return {
        "detected_start_time": _iso(earliest),
        "detected_end_time": _iso(latest),
        "duration_hours": round(duration_hours, 2),
        "timestamp_parse_rate": round(parse_rate, 4),
        "total_lines": total_lines,
        "timestamped_events": timestamped_events,
        "invalid_timestamp_lines": invalid_timestamp_lines,
        "source_files": source_files,
        "severity_counts": dict(severity_counts),
        "segments": segments,
        "recommended_start_time": _iso(recommended_start),
        "recommended_end_time": _iso(recommended_end),
        "requires_confirmation": requires_confirmation,
        "can_select_time_range": True,
        "warnings": warnings,
        "reason": "confirmation_required" if requires_confirmation else "range_accepted",
        "timezone_note": "日志未携带时区，时间按日志原始值处理",
    }
