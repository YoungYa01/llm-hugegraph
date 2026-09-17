from __future__ import annotations

import fnmatch
import gzip
import shutil
import tempfile
import zipfile
from dataclasses import asdict
from pathlib import Path
from typing import Iterator

import pandas as pd

from .parsers import ParserRegistry
from .schema import FileParseResult, ParsedEvent


DEFAULT_SUFFIXES = {
    ".log", ".txt", ".out", ".json", ".jsonl", ".ndjson", ".access", ".error", "",
}


def _matches_any(path: str, patterns: list[str]) -> bool:
    normalized = path.replace("\\", "/")
    for pattern in patterns:
        if fnmatch.fnmatch(normalized, pattern):
            return True
        if pattern.startswith("**/") and fnmatch.fnmatch(normalized, pattern[3:]):
            return True
    return False


def discover_log_files(
    root: Path,
    include_globs: list[str],
    exclude_globs: list[str],
    supported_suffixes: list[str] | set[str] | None = None,
) -> list[Path]:
    suffixes = {str(item).lower() for item in (supported_suffixes or DEFAULT_SUFFIXES)}
    if root.is_file():
        if root.suffix.lower() in suffixes:
            return [root]
        raise ValueError(f"不支持的日志文件类型: {root.suffix or '<无扩展名>'}")
    if not root.is_dir():
        raise ValueError(f"输入必须是日志文件、目录、ZIP 或 GZIP: {root}")

    files: list[Path] = []
    for candidate in root.rglob("*"):
        if not candidate.is_file() or candidate.suffix.lower() not in suffixes:
            continue
        relative = candidate.relative_to(root).as_posix()
        if include_globs and not _matches_any(relative, include_globs):
            continue
        if exclude_globs and _matches_any(relative, exclude_globs):
            continue
        files.append(candidate)
    return sorted(files)


def _safe_extract_zip(
    archive: zipfile.ZipFile,
    destination: Path,
    *,
    max_files: int = 2000,
    max_uncompressed_bytes: int = 1024 * 1024 * 1024,
) -> None:
    root = destination.resolve()
    file_count = 0
    total_size = 0
    for item in archive.infolist():
        target = (root / item.filename).resolve()
        if not target.is_relative_to(root):
            raise ValueError("ZIP 包含不安全的目录路径")
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        file_count += 1
        total_size += max(0, int(item.file_size))
        if file_count > max_files:
            raise ValueError(f"ZIP 中文件数超过 {max_files} 个限制")
        if total_size > max_uncompressed_bytes:
            raise ValueError("ZIP 解压后的总大小超过安全限制")
        if item.file_size > 10 * 1024 * 1024 and item.compress_size > 0:
            if item.file_size / item.compress_size > 500:
                raise ValueError(f"ZIP 文件 {item.filename} 压缩比异常")
        target.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(item, "r") as source, target.open("wb") as output:
            shutil.copyfileobj(source, output)


def _decode_file(path: Path, configured_encoding: str, errors: str) -> tuple[list[str], str]:
    raw = path.read_bytes()
    if not raw:
        return [], configured_encoding if configured_encoding != "auto" else "utf-8"
    if raw.count(b"\x00") / len(raw) > 0.05 and not raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise ValueError("文件疑似二进制内容")
    if configured_encoding and configured_encoding.lower() != "auto":
        return raw.decode(configured_encoding, errors=errors).splitlines(), configured_encoding
    for encoding, bom in (
        ("utf-8-sig", b"\xef\xbb\xbf"), ("utf-16", b"\xff\xfe"), ("utf-16", b"\xfe\xff"),
    ):
        if raw.startswith(bom):
            return raw.decode(encoding, errors=errors).splitlines(), encoding
    for encoding in ("utf-8", "gb18030"):
        try:
            return raw.decode(encoding, errors="strict").splitlines(), encoding
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors=errors).splitlines(), "utf-8-replacement"


def _safe_expand_gzip(source: Path, target: Path, max_uncompressed_bytes: int) -> None:
    total = 0
    with gzip.open(source, "rb") as compressed, target.open("wb") as output:
        while True:
            chunk = compressed.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_uncompressed_bytes:
                raise ValueError("GZIP 解压后的大小超过安全限制")
            output.write(chunk)


def parse_log_file_with_report(
    path: Path,
    *,
    logical_source: str | None = None,
    encoding: str = "auto",
    errors: str = "replace",
    parser_config: dict | None = None,
) -> tuple[FileParseResult, list[tuple[str, float]]]:
    config = parser_config or {}
    lines, used_encoding = _decode_file(path, encoding, errors)
    source_file = logical_source or path.name
    result, scores = ParserRegistry(
        max_event_lines=int(config.get("max_event_lines", 2000))
    ).parse(
        lines,
        Path(source_file),
        source_file,
        sample_size=max(20, int(config.get("detection_sample_lines", 200))),
        minimum_confidence=max(0.0, float(config.get("minimum_confidence", 0.1))),
    )
    result.encoding = used_encoding
    return result, scores


def parse_log_file(
    path: Path,
    encoding: str = "auto",
    errors: str = "replace",
) -> Iterator[ParsedEvent]:
    result, _ = parse_log_file_with_report(path, encoding=encoding, errors=errors)
    yield from result.events


def load_events(input_path: str | Path, input_config: dict) -> pd.DataFrame:
    source = Path(input_path)
    temp_dir: tempfile.TemporaryDirectory[str] | None = None
    try:
        suffix = source.suffix.lower()
        if source.is_file() and suffix == ".zip":
            temp_dir = tempfile.TemporaryDirectory(prefix="logfault-")
            with zipfile.ZipFile(source, "r") as archive:
                _safe_extract_zip(
                    archive,
                    Path(temp_dir.name),
                    max_files=max(1, int(input_config.get("max_archive_files", 2000))),
                    max_uncompressed_bytes=max(1, int(input_config.get("max_archive_uncompressed_mb", 1000))) * 1024 * 1024,
                )
            root = Path(temp_dir.name)
        elif source.is_file() and suffix == ".gz":
            temp_dir = tempfile.TemporaryDirectory(prefix="logfault-")
            expanded = Path(temp_dir.name) / source.stem
            _safe_expand_gzip(
                source,
                expanded,
                max(1, int(input_config.get("max_archive_uncompressed_mb", 1000))) * 1024 * 1024,
            )
            root = expanded
        else:
            root = source

        files = discover_log_files(
            root,
            input_config.get("include_globs", ["**/*"]),
            input_config.get("exclude_globs", []),
            input_config.get("supported_suffixes", DEFAULT_SUFFIXES),
        )
        if not files:
            raise ValueError("没有找到符合条件的日志文件")

        records: list[dict] = []
        unparsed_records: list[dict] = []
        unparsed_total = 0
        file_reports: list[dict] = []
        parser_counts: dict[str, int] = {}
        max_unparsed_records = max(0, int(input_config.get("max_unparsed_records", 1000)))
        max_unparsed_chars = max(100, int(input_config.get("max_unparsed_record_chars", 20000)))

        def retain_unparsed(item: dict) -> None:
            if len(unparsed_records) >= max_unparsed_records:
                return
            retained = dict(item)
            raw_text = str(retained.get("raw_text") or "")
            if len(raw_text) > max_unparsed_chars:
                retained["raw_text"] = raw_text[:max_unparsed_chars]
                retained["truncated"] = True
                retained["original_chars"] = len(raw_text)
            unparsed_records.append(retained)

        for file_path in files:
            try:
                logical_source = file_path.relative_to(root).as_posix() if root.is_dir() else file_path.name
            except ValueError:
                logical_source = file_path.name
            try:
                parsed, scores = parse_log_file_with_report(
                    file_path,
                    logical_source=logical_source,
                    encoding=input_config.get("encoding", "auto"),
                    errors=input_config.get("encoding_errors", "replace"),
                    parser_config=input_config,
                )
            except (OSError, UnicodeError, ValueError) as exc:
                file_reports.append({
                    "source_file": logical_source,
                    "parser": "rejected",
                    "confidence": 0.0,
                    "encoding": "",
                    "total_lines": 0,
                    "events": 0,
                    "unparsed_blocks": 1,
                    "error": str(exc),
                })
                unparsed_total += 1
                retain_unparsed({
                    "source_file": logical_source,
                    "start_line": 0,
                    "end_line": 0,
                    "raw_text": "",
                    "reason": str(exc),
                    "parser_name": "rejected",
                })
                continue
            parser_counts[parsed.parser_name] = parser_counts.get(parsed.parser_name, 0) + len(parsed.events)
            file_reports.append({
                "source_file": logical_source,
                "parser": parsed.parser_name,
                "confidence": round(parsed.parser_confidence, 4),
                "encoding": parsed.encoding,
                "total_lines": parsed.total_lines,
                "events": len(parsed.events),
                "unparsed_blocks": len(parsed.unparsed),
                "candidate_scores": dict(scores),
            })
            unparsed_total += len(parsed.unparsed)
            for item in parsed.unparsed:
                retain_unparsed(asdict(item))
            for event in parsed.events:
                record = asdict(event)
                record["source_file"] = logical_source
                record["event_id"] = f"{logical_source}:{event.source_line}"
                records.append(record)

        if not records:
            reasons = sorted({str(item.get("reason") or "") for item in unparsed_records if item.get("reason")})
            detail = "；".join(reasons[:3])
            raise ValueError(f"找到日志文件，但没有解析出带有效时间戳的日志事件{f'：{detail}' if detail else ''}")
        frame = pd.DataFrame.from_records(records)
        frame["timestamp"] = pd.to_datetime(frame["timestamp"])
        frame = frame.sort_values(["timestamp", "source_file", "source_line"]).reset_index(drop=True)
        total_lines = sum(int(item.get("total_lines") or 0) for item in file_reports)
        covered_lines = sum(
            max(1, int(record.get("source_line_end") or record["source_line"]) - int(record["source_line"]) + 1)
            for record in records
        )
        frame.attrs["parse_quality"] = {
            "source_files": len(file_reports),
            "total_physical_lines": total_lines,
            "logical_events": len(records),
            "unparsed_blocks": unparsed_total,
            "retained_unparsed_records": len(unparsed_records),
            "event_line_coverage": round(covered_lines / max(1, total_lines), 4),
            "parser_distribution": parser_counts,
            "files": file_reports,
        }
        frame.attrs["unparsed_records"] = unparsed_records
        return frame
    finally:
        if temp_dir is not None:
            temp_dir.cleanup()


__all__ = [
    "ParsedEvent", "discover_log_files", "load_events", "parse_log_file", "parse_log_file_with_report",
]
