"""两遍流式日志分析：事件不驻留内存。

第一遍：流式解析 → Drain 打标 → 滑动窗口增量聚合。
    常驻内存只有「活跃窗口」（默认 5 分钟窗口约 6 个）和每个窗口的稀疏计数，
    与日志总量无关。

第二遍：流式解析 → 只回捞异常窗口区域与全部 ERROR/FATAL 事件。
    用于 Incident 聚类和取证时间线。

窗口矩阵、模板、模型、Incident 规则全部复用现有实现，不复制判定逻辑。
与 ``run_pipeline`` 的差异仅在事件级数据的取用方式：
``events.csv`` 只保留信号事件和异常区域事件，不再是全量事件表。
"""

from __future__ import annotations

import argparse
import heapq
import json
import sys
import tempfile
import time
import zipfile
from collections import Counter
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import joblib
import numpy as np
import pandas as pd

from .config import load_config, merge_config
from .drain_adapter import DrainParser
from .explain import (
    ERROR_LEVELS,
    EVENT_TEXT_KEYS,
    ROOT_KEYWORDS,
    _has_keyword,
    _is_technical_error,
    annotate_windows,
    merge_anomaly_windows,
)
from .features import WindowedData
from .ingest import _safe_expand_gzip, _safe_extract_zip, discover_log_files
from .model import fit_and_detect
from .parsers import HeaderBlockParser, ParserRegistry
from .pipeline import _save_frame

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# 流式读取
# --------------------------------------------------------------------------- #

def _to_ns(value: datetime) -> int:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    delta = value - _EPOCH
    return (delta.days * 86_400 + delta.seconds) * 1_000_000_000 + delta.microseconds * 1_000


def _detect_encoding(path: Path, configured: str) -> str:
    """按样本检测编码，避免把整个文件读进内存。"""
    if configured and configured.lower() != "auto":
        return configured
    with path.open("rb") as handle:
        head = handle.read(1 << 20)
    if not head:
        return "utf-8"
    if head.count(b"\x00") / len(head) > 0.05 and not head.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise ValueError(f"{path.name} 疑似二进制内容")
    for encoding, bom in (("utf-8-sig", b"\xef\xbb\xbf"), ("utf-16", b"\xff\xfe"), ("utf-16", b"\xfe\xff")):
        if head.startswith(bom):
            return encoding
    try:
        # 截断末尾 4 字节，避免样本正好切在多字节字符中间
        head[:-4].decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        return "gb18030"


def _sample_lines(path: Path, encoding: str, errors: str, head_n: int, tail_n: int) -> list[str]:
    """取文件头尾样本用于格式探测，与 ParserRegistry.detect 的头尾抽样思路一致。"""
    lines: list[str] = []
    with path.open("r", encoding=encoding, errors=errors) as handle:
        for line in handle:
            lines.append(line.rstrip("\r\n"))
            if len(lines) >= head_n:
                break
    with path.open("rb") as handle:
        handle.seek(0, 2)
        size = handle.tell()
        back = min(size, 262_144)
        handle.seek(size - back)
        tail = handle.read(back).decode(encoding, errors="replace").splitlines()
    lines.extend(tail[-tail_n:])
    return lines


def _iter_blocks(
    handle: Any,
    parser: Any,
    max_event_lines: int,
) -> Iterator[tuple[int, list[str]]]:
    """切分事件块：多行格式按 header 分块，单行格式一行一块。"""
    if not isinstance(parser, HeaderBlockParser):
        for number, line in enumerate(handle, 1):
            yield number, [line.rstrip("\r\n")]
        return

    block: list[str] = []
    start = 0
    for number, line in enumerate(handle, 1):
        text = line.rstrip("\r\n")
        if parser.parse_header(text) is not None:
            if block:
                yield start, block
            block = [text]
            start = number
        elif block:
            if len(block) < max_event_lines:
                block.append(text)
            else:
                yield start, block
                block = [text]
                start = number
        else:
            block = [text]
            start = number
    if block:
        yield start, block


def _file_events(
    path: Path,
    logical: str,
    input_config: dict,
    parser_config: dict,
    sink: dict,
) -> Iterator[Any]:
    """逐事件产出，解析质量写入 sink。"""
    errors = str(input_config.get("encoding_errors", "replace"))
    max_event_lines = max(2, int(parser_config.get("max_event_lines", 2000)))
    report = {
        "source_file": logical,
        "parser": "unrecognized",
        "confidence": 0.0,
        "encoding": "",
        "total_lines": 0,
        "events": 0,
        "unparsed_blocks": 0,
    }
    try:
        encoding = _detect_encoding(path, str(input_config.get("encoding", "auto")))
        sample = _sample_lines(path, encoding, errors, 200, 100)
        registry = ParserRegistry(max_event_lines=max_event_lines)
        parser, confidence, scores = registry.detect(
            sample, sample_size=max(20, int(parser_config.get("detection_sample_lines", 200)))
        )
    except (OSError, UnicodeError, ValueError) as exc:
        report["error"] = str(exc)
        sink["files"].append(report)
        sink["unparsed_total"] += 1
        _retain_unparsed(sink, logical, 0, 0, "", str(exc), "rejected")
        return

    report.update(
        {
            "parser": parser.name,
            "confidence": round(confidence, 4),
            "encoding": encoding,
            "candidate_scores": dict(scores),
        }
    )
    sink["files"].append(report)

    if confidence < float(parser_config.get("minimum_confidence", 0.1)):
        report["parser"] = "unrecognized"
        sink["unparsed_total"] += 1
        _retain_unparsed(
            sink, logical, 1, 0, "", "no_parser_reached_minimum_confidence", "unrecognized"
        )
        return

    with path.open("r", encoding=encoding, errors=errors) as handle:
        for start, block in _iter_blocks(handle, parser, max_event_lines):
            result = parser.parse(block, path, logical, confidence)
            offset = start - 1
            report["total_lines"] += len(block)
            for event in result.events:
                event.source_line += offset
                event.source_line_end = (event.source_line_end or event.source_line) + offset
                event.source_file = logical
                report["events"] += 1
                sink["events"] += 1
                sink["covered_lines"] += (
                    event.source_line_end - event.source_line + 1
                    if event.source_line_end > event.source_line
                    else 1
                )
                yield event
            for record in result.unparsed:
                record.start_line += offset
                record.end_line = (record.end_line or record.start_line) + offset
                report["unparsed_blocks"] += 1
                sink["unparsed_total"] += 1
                _retain_unparsed(
                    sink, logical, record.start_line, record.end_line,
                    record.raw_text, record.reason, record.parser_name,
                )


def _retain_unparsed(
    sink: dict, source_file: str, start: int, end: int,
    raw_text: str, reason: str, parser_name: str,
) -> None:
    if len(sink["unparsed"]) >= sink["unparsed_limit"]:
        return
    text = raw_text or ""
    item = {
        "source_file": source_file,
        "start_line": start,
        "end_line": end,
        "raw_text": text,
        "reason": reason,
        "parser_name": parser_name,
    }
    if len(text) > sink["unparsed_chars"]:
        item["raw_text"] = text[: sink["unparsed_chars"]]
        item["truncated"] = True
        item["original_chars"] = len(text)
    sink["unparsed"].append(item)


def _ordered_events(
    files: list[tuple[Path, str]],
    input_config: dict,
    parser_config: dict,
    sink: dict,
    reorder_seconds: float,
) -> Iterator[Any]:
    """多文件归并 + 乱序缓冲，保证输出严格按 (timestamp, source_file, source_line) 递增。

    窗口能提前封口、Drain 打标顺序与全量实现一致，都依赖这个顺序。
    """
    streams = [
        _file_events(path, logical, input_config, parser_config, sink)
        for path, logical in files
    ]
    merged = heapq.merge(*streams, key=lambda event: (event.timestamp, event.source_file, event.source_line))

    tolerance = int(reorder_seconds * 1_000_000_000)
    buffer: list[tuple[tuple[int, str, int], Any]] = []
    max_seen = -1
    last_emitted = -1
    for event in merged:
        stamp = _to_ns(event.timestamp)
        heapq.heappush(buffer, ((stamp, event.source_file, event.source_line), event))
        if stamp > max_seen:
            max_seen = stamp
        while buffer and buffer[0][0][0] + tolerance <= max_seen:
            item = heapq.heappop(buffer)[1]
            if _to_ns(item.timestamp) < last_emitted:
                sink["late_events"] += 1
            last_emitted = max(last_emitted, _to_ns(item.timestamp))
            yield item
    while buffer:
        item = heapq.heappop(buffer)[1]
        if _to_ns(item.timestamp) < last_emitted:
            sink["late_events"] += 1
        last_emitted = max(last_emitted, _to_ns(item.timestamp))
        yield item


# --------------------------------------------------------------------------- #
# 第一遍：打标 + 窗口聚合
# --------------------------------------------------------------------------- #

def _signal_row(event: Any) -> dict[str, Any]:
    return {
        "message": event.message,
        "semantic_message": event.semantic_message,
        "root_cause": event.root_cause,
        "raw_block": event.raw_block,
        "level": event.level,
        "root_exception_class": event.root_exception_class,
        "exception_class": event.exception_class,
    }


def _signal_text(event: Any) -> str:
    """等价于 ``_event_text(_signal_row(event))``，但不构造中间字典。

    第一遍要扫过全部事件（2 GB 样本约 560 万条），为 7 个字段建一次 dict 是纯开销；
    ``ParsedEvent`` 的这些字段本身就是 str，直接取用即可。
    """
    return " ".join(getattr(event, key) for key in EVENT_TEXT_KEYS).lower()


def _scan(
    files: list[tuple[Path, str]],
    config: dict,
    sink: dict,
    reorder_seconds: float,
) -> dict[str, Any]:
    window_config = config["window"]
    feature_config = config["features"]
    size_ns = int(window_config.get("size_minutes", 5)) * 60 * 1_000_000_000
    step_ns = int(window_config.get("step_minutes", 1)) * 60 * 1_000_000_000
    min_events = int(window_config.get("min_events", 1))
    namespace_by_service = bool(feature_config.get("namespace_by_service", True))
    include_levels = bool(feature_config.get("include_levels", False))

    miner = DrainParser(config["parser"])
    feature_names: list[str] = []
    feature_index: dict[str, int] = {}
    template_text: dict[str, str] = {}
    template_counts: Counter[str] = Counter()

    alive: dict[int, dict[str, Any]] = {}
    closed: list[dict[str, Any]] = []
    kept_rows: list[dict[str, Any]] = []
    observed_tz = None
    # 与全量实现一致：窗口起点从首个事件所在的网格点开始，不向前补空窗口
    lower_bound: int | None = None

    def feature_id(event: Any, template_id: str) -> int:
        name = f"{event.service}::{template_id}" if namespace_by_service else template_id
        if include_levels:
            name = f"{name}::{event.level}"
        index = feature_index.get(name)
        if index is None:
            index = len(feature_names)
            feature_index[name] = index
            feature_names.append(name)
        return index

    def close(start: int) -> None:
        state = alive.pop(start)
        if state["count"] < min_events:
            return
        closed.append(
            {
                "start": start,
                "ids": np.fromiter(state["counts"].keys(), dtype=np.int32, count=len(state["counts"])),
                "values": np.fromiter(state["counts"].values(), dtype=float, count=len(state["counts"])),
                "event_count": state["count"],
            }
        )

    for event in _ordered_events(files, config["input"], config["parser"], sink, reorder_seconds):
        if sink["events"] % 500_000 == 0:
            print(f"[stream] 已扫描 {sink['events']:,} 条", file=sys.stderr, flush=True)
        if observed_tz is None and event.timestamp.tzinfo is not None:
            observed_tz = event.timestamp.tzinfo

        template_id, template = miner.add(event.semantic_message)
        template_text[template_id] = template
        template_counts[template_id] += 1
        index = feature_id(event, template_id)

        stamp = _to_ns(event.timestamp)
        level = str(event.level).upper()
        is_error = level in ERROR_LEVELS
        # 根因文本每条事件只拼一次。原写法把 _event_text(row) 写在 any(...) 的
        # 生成器里，等于每条事件重复拼装并小写 23 遍，是流式扫描的头号热点。
        text = _signal_text(event)
        # ERROR/FATAL 必然保留，无需再做关键词扫描
        root_signal = is_error or _has_keyword(text, ROOT_KEYWORDS)
        # _is_technical_error 对非 ERROR/FATAL 恒为 False，短路可省掉绝大部分文本构造
        technical = is_error and _is_technical_error(_signal_row(event), text)
        keep = is_error or technical or root_signal

        # 事件属于所有满足 start <= t < start+size 的窗口，最多 size/step 个
        start = stamp - (stamp % step_ns)
        if lower_bound is None:
            lower_bound = start
        while start > stamp - size_ns and start >= lower_bound:
            state = alive.get(start)
            if state is None:
                state = {"counts": {}, "count": 0, "services": set(), "traces": set()}
                alive[start] = state
            counts = state["counts"]
            counts[index] = counts.get(index, 0) + 1
            state["count"] += 1
            # 每个窗口保留每个服务的首个事件，annotate_windows 才能还原服务集合
            if event.service not in state["services"]:
                state["services"].add(event.service)
                keep = True
            if event.trace_id and len(state["traces"]) < 32 and event.trace_id not in state["traces"]:
                state["traces"].add(event.trace_id)
                keep = True
            start -= step_ns

        if keep:
            kept_rows.append(asdict(event))

        while alive and min(alive) + size_ns <= stamp:
            close(min(alive))

    while alive:
        close(min(alive))

    if not feature_names:
        raise ValueError("没有解析出任何日志事件，无法构造窗口")
    if not closed:
        raise ValueError("没有生成有效窗口，请检查时间戳或 min_events 配置")

    return {
        "feature_names": feature_names,
        "closed": closed,
        "kept_rows": kept_rows,
        "template_text": template_text,
        "template_counts": template_counts,
        "observed_tz": observed_tz,
        "parser_backend": miner.backend,
    }


def _build_windows(scan: dict[str, Any], size_minutes: int) -> WindowedData:
    feature_names = scan["feature_names"]
    order = sorted(range(len(feature_names)), key=feature_names.__getitem__)
    remap = np.empty(len(feature_names), dtype=np.int32)
    for new_position, old_position in enumerate(order):
        remap[old_position] = new_position
    columns = [feature_names[old] for old in order]

    closed = sorted(scan["closed"], key=lambda item: item["start"])
    matrix = np.zeros((len(closed), len(columns)), dtype=float)
    for row, item in enumerate(closed):
        matrix[row, remap[item["ids"]]] = item["values"]

    tz = scan["observed_tz"]
    span = size_minutes * 60 * 1_000_000_000

    def stamp(value: int) -> pd.Timestamp:
        return pd.Timestamp(value) if tz is None else pd.Timestamp(value, tz="UTC").tz_convert(tz)

    metadata = pd.DataFrame(
        {
            "window_id": [f"W{index + 1:06d}" for index in range(len(closed))],
            "window_start": [stamp(item["start"]) for item in closed],
            "window_end": [stamp(item["start"] + span) for item in closed],
            "event_count": [item["event_count"] for item in closed],
        }
    )
    # explain._prepare_window_event_index 直接用 int64 做 searchsorted，
    # 时间列必须与事件表同一精度，否则 ns/us 混用会切出空区间。
    for column in ("window_start", "window_end"):
        metadata[column] = pd.to_datetime(metadata[column]).dt.as_unit("ns")
    return WindowedData(metadata=metadata, matrix=pd.DataFrame(matrix, columns=columns))


# --------------------------------------------------------------------------- #
# 第二遍：回捞异常区域事件
# --------------------------------------------------------------------------- #

def _abnormal_ranges(windows: pd.DataFrame, explain_config: dict) -> list[tuple[int, int]]:
    abnormal = windows.loc[windows["is_anomaly"].fillna(False).astype(bool)]
    if abnormal.empty:
        return []
    before = int(float(explain_config.get("context_before_seconds", 60)) * 1_000_000_000)
    after = int(float(explain_config.get("context_after_seconds", 120)) * 1_000_000_000)
    ranges: list[tuple[int, int]] = []
    for _, row in abnormal.sort_values("window_start").iterrows():
        start = _to_ns(pd.Timestamp(row["window_start"]).to_pydatetime()) - before
        end = _to_ns(pd.Timestamp(row["window_end"]).to_pydatetime()) + after
        if ranges and start <= ranges[-1][1]:
            ranges[-1] = (ranges[-1][0], max(ranges[-1][1], end))
        else:
            ranges.append((start, end))
    return ranges


def _collect_regions(
    files: list[tuple[Path, str]],
    config: dict,
    reorder_seconds: float,
    ranges: list[tuple[int, int]],
) -> pd.DataFrame:
    """回捞异常区域事件。

    ERROR/WARN 全量保留（Incident 聚类只依赖它们）；其余事件按「每秒一条」抽样，
    因为时间线最终只展示 ``max_timeline_events`` 行，不抽样会让峰值随日志密度线性上涨。
    """
    sink = {
        "files": [], "unparsed": [], "unparsed_total": 0, "events": 0,
        "covered_lines": 0, "late_events": 0, "unparsed_limit": 0, "unparsed_chars": 0,
    }
    rows: list[dict[str, Any]] = []
    seen: set[tuple[int, int]] = set()
    for event in _ordered_events(files, config["input"], config["parser"], sink, reorder_seconds):
        level = str(event.level).upper()
        if level in ERROR_LEVELS or level == "WARN":
            rows.append(asdict(event))
            continue
        stamp = _to_ns(event.timestamp)
        for index, (start, end) in enumerate(ranges):
            if start <= stamp <= end:
                bucket = (index, stamp // 1_000_000_000)
                if bucket not in seen:
                    seen.add(bucket)
                    rows.append(asdict(event))
                break
    if not rows:
        return pd.DataFrame()
    frame = pd.DataFrame.from_records(rows)
    frame["timestamp"] = pd.to_datetime(frame["timestamp"])
    return frame.sort_values(["timestamp", "source_file", "source_line"]).reset_index(drop=True)


# --------------------------------------------------------------------------- #
# 编排
# --------------------------------------------------------------------------- #

def _resolve_input(input_path: str | Path, input_config: dict) -> tuple[Path, list[tuple[Path, str]], Any]:
    source = Path(input_path)
    temp_dir = None
    suffix = source.suffix.lower()
    # 解压可能占用与日志等量的磁盘，允许指定到空间充足的盘。
    temp_root = str(input_config.get("temp_dir") or "").strip() or None
    if temp_root:
        Path(temp_root).mkdir(parents=True, exist_ok=True)
    if source.is_file() and suffix == ".zip":
        temp_dir = tempfile.TemporaryDirectory(prefix="logfault-stream-", dir=temp_root)
        with zipfile.ZipFile(source, "r") as archive:
            _safe_extract_zip(
                archive,
                Path(temp_dir.name),
                max_files=max(1, int(input_config.get("max_archive_files", 2000))),
                max_uncompressed_bytes=max(1, int(input_config.get("max_archive_uncompressed_mb", 1000))) * 1024 * 1024,
            )
        root = Path(temp_dir.name)
    elif source.is_file() and suffix == ".gz":
        temp_dir = tempfile.TemporaryDirectory(prefix="logfault-stream-", dir=temp_root)
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
        input_config.get("supported_suffixes", None),
    )
    if not files:
        raise ValueError("没有找到符合条件的日志文件")
    pairs: list[tuple[Path, str]] = []
    for path in files:
        try:
            logical = path.relative_to(root).as_posix() if root.is_dir() else path.name
        except ValueError:
            logical = path.name
        pairs.append((path, logical))
    return root, pairs, temp_dir


def run_stream_pipeline(
    input_path: str | Path,
    output_dir: str | Path,
    config_path: str | Path | None = None,
    model_override: str | None = None,
    *,
    reorder_seconds: float = 60.0,
    config_override: dict[str, Any] | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    config = load_config(config_path)
    if config_override:
        config = merge_config(config, config_override)
    if model_override:
        config["model"]["type"] = model_override

    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)

    sink = {
        "files": [],
        "unparsed": [],
        "unparsed_total": 0,
        "events": 0,
        "covered_lines": 0,
        "late_events": 0,
        "unparsed_limit": max(0, int(config["input"].get("max_unparsed_records", 1000))),
        "unparsed_chars": max(100, int(config["input"].get("max_unparsed_record_chars", 20000))),
    }

    root, pairs, temp_dir = _resolve_input(input_path, config["input"])
    try:
        scan_started = time.perf_counter()
        scan = _scan(pairs, config, sink, reorder_seconds)
        windowed = _build_windows(scan, int(config["window"].get("size_minutes", 5)))
        scan_seconds = time.perf_counter() - scan_started

        detection = fit_and_detect(
            target_features=windowed.matrix,
            train_features=None,
            model_config=config["model"],
            pca_config=config["pca"],
        )
        training_windows = len(windowed.matrix)
        minimum_windows = max(1, int(config["model"].get("min_training_windows", 30)))
        insufficient = training_windows < minimum_windows

        aligned = windowed.matrix.reindex(columns=detection.artifacts.feature_names, fill_value=0.0)
        projected = pd.DataFrame.from_records(scan["kept_rows"])
        projected["timestamp"] = pd.to_datetime(projected["timestamp"]).dt.as_unit("ns")

        annotated = annotate_windows(
            metadata=windowed.metadata,
            feature_matrix=aligned,
            standardized=detection.standardized,
            scores=detection.anomaly_score,
            flags=detection.is_anomaly,
            events=projected,
            explain_config=config["explain"],
            insufficient_model_samples=insufficient,
        )

        collect_started = time.perf_counter()
        ranges = _abnormal_ranges(annotated, config["explain"])
        region_events = _collect_regions(pairs, config, reorder_seconds, ranges)
        if region_events.empty:
            # 空表沿用投影事件的列与时间类型，避免下游拿到 object 时间列
            region_events = projected.iloc[0:0].copy()
        collect_seconds = time.perf_counter() - collect_started

        incidents, details, event_mapping, exception_mapping, unassigned = merge_anomaly_windows(
            annotated, region_events, config["explain"], return_mappings=True
        )

        templates = pd.DataFrame(
            [
                {"template_id": key, "template": scan["template_text"].get(key, ""), "occurrences": count}
                for key, count in scan["template_counts"].items()
            ]
        )
        if not templates.empty:
            templates = templates.sort_values(
                ["occurrences", "template_id"], ascending=[False, True]
            ).reset_index(drop=True)

        total_lines = sum(int(item.get("total_lines") or 0) for item in sink["files"])
        parser_distribution: Counter[str] = Counter()
        for item in sink["files"]:
            parser_distribution[str(item.get("parser"))] += int(item.get("events") or 0)
        parse_quality = {
            "source_files": len(sink["files"]),
            "total_physical_lines": total_lines,
            "logical_events": sink["events"],
            "unparsed_blocks": sink["unparsed_total"],
            "retained_unparsed_records": len(sink["unparsed"]),
            "event_line_coverage": round(sink["covered_lines"] / max(1, total_lines), 4),
            "parser_distribution": dict(parser_distribution),
            "files": sink["files"],
        }

        _save_frame(region_events, output / "events.csv")
        _save_frame(templates, output / "templates.csv")
        (output / "parse_quality.json").write_text(
            json.dumps(parse_quality, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (output / "unparsed_records.jsonl").write_text(
            "".join(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n" for item in sink["unparsed"]),
            encoding="utf-8",
        )

        window_features = pd.concat([windowed.metadata, aligned], axis=1)
        _save_frame(window_features, output / "window_features.csv")

        embedding_columns = [f"pc_{index + 1:02d}" for index in range(detection.embeddings.shape[1])]
        embeddings = pd.DataFrame(detection.embeddings, columns=embedding_columns)
        embeddings = pd.concat(
            [
                windowed.metadata.reset_index(drop=True),
                embeddings,
                pd.DataFrame(
                    {
                        "anomaly_score": detection.anomaly_score,
                        "model_is_anomaly": detection.is_anomaly,
                        "is_anomaly": annotated["is_anomaly"].to_numpy(dtype=bool),
                        "anomaly_reason": annotated["anomaly_reason"].to_numpy(),
                    }
                ),
            ],
            axis=1,
        )
        _save_frame(embeddings, output / "window_embeddings.csv")
        _save_frame(annotated, output / "anomaly_windows.csv")
        _save_frame(incidents, output / "incidents.csv")
        _save_frame(event_mapping, output / "event_incident_mapping.csv")
        _save_frame(exception_mapping, output / "exception_incident_mapping.csv")
        _save_frame(unassigned, output / "unassigned_error_events.csv")
        (output / "incident_details.json").write_text(
            json.dumps(details, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (output / "effective_config.json").write_text(
            json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        joblib.dump(detection.artifacts, output / "model_artifacts.joblib")

        summary = {
            "input": str(input_path),
            "output": str(output),
            "mode": "stream",
            "parser_backend": scan["parser_backend"],
            "parse_quality": parse_quality,
            "events": sink["events"],
            "templates": len(templates),
            "windows": len(annotated),
            "model_anomaly_windows": int(annotated["model_is_anomaly"].sum()),
            "anomaly_windows": int(annotated["is_anomaly"].sum()),
            "incidents": len(incidents),
            "parsed_root_exception_classes": int(
                region_events.loc[
                    region_events["root_exception_class"].fillna("").astype(str).str.strip() != "",
                    "root_exception_class",
                ].nunique()
            ) if "root_exception_class" in region_events else 0,
            "incident_root_exception_classes": int(exception_mapping["root_exception_class"].nunique())
            if not exception_mapping.empty and "root_exception_class" in exception_mapping else 0,
            "unassigned_error_events": len(unassigned),
            "pca_components": detection.embeddings.shape[1],
            "pca_explained_variance": detection.artifacts.explained_variance,
            "model": detection.artifacts.detector_type,
            "detection_mode": "insufficient_samples_rule_fallback" if insufficient else "model",
            "training_windows": training_windows,
            "minimum_training_windows": minimum_windows,
            "stream": {
                "source_files": len(pairs),
                "scanned_events": sink["events"],
                "kept_signal_events": len(scan["kept_rows"]),
                "region_events": len(region_events),
                "abnormal_ranges": len(ranges),
                "late_events": sink["late_events"],
                "scan_seconds": round(scan_seconds, 1),
                "collect_seconds": round(collect_seconds, 1),
                "total_seconds": round(time.perf_counter() - started, 1),
            },
        }
        summary["root_exception_classes"] = summary["incident_root_exception_classes"]
        (output / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        _write_report(output, summary)
        return summary
    finally:
        if temp_dir is not None:
            temp_dir.cleanup()


def _write_report(output: Path, summary: dict[str, Any]) -> None:
    stream = summary["stream"]
    lines = [
        "# 日志异常检测与故障定位报告（流式模式）",
        "",
        "## 运行概览",
        "",
        f"- Drain 后端：`{summary['parser_backend']}`",
        f"- 扫描事件数：{stream['scanned_events']}（全量，仅流式经过内存）",
        f"- 保留信号事件数：{stream['kept_signal_events']}（用于窗口标注）",
        f"- 回捞异常区域事件数：{stream['region_events']}（用于 Incident 与时间线）",
        f"- 日志模板数：{summary['templates']}",
        f"- 滑动窗口数：{summary['windows']}",
        f"- 模型直接判定异常窗口数：{summary['model_anomaly_windows']}",
        f"- 加入技术故障规则后的候选窗口数：{summary['anomaly_windows']}",
        f"- 故障 episode 聚合后的 Incident 数：{summary['incidents']}",
        f"- 实际进入 Incident 的 root exception class 种类数：{summary['incident_root_exception_classes']}",
        f"- 未提升为 Incident 的 ERROR/FATAL 事件数：{summary['unassigned_error_events']}",
        f"- PCA 维数：{summary['pca_components']}",
        f"- PCA 累计解释方差：{summary['pca_explained_variance']:.4f}",
        "",
        "## 流式口径",
        "",
        "第一遍流式扫描完成解析、Drain 打标与滑动窗口聚合，内存只保留活跃窗口；",
        "第二遍流式扫描只回捞异常窗口前后区域与全部 ERROR/FATAL 事件。",
        "因此 `events.csv` 是取证子集，不是全量事件表——全量事件数见「扫描事件数」。",
        "`anomaly_windows.csv` 的 `trace_ids` 是窗口内 trace 的采样，不是严格频次 top-N。",
        "",
        "## 耗时",
        "",
        f"- 第一遍扫描：{stream['scan_seconds']} 秒",
        f"- 第二遍回捞：{stream['collect_seconds']} 秒",
        f"- 总耗时：{stream['total_seconds']} 秒",
        "",
        "## 注意",
        "",
        "异常检测负责发现异常时间段；根因字段仍是可解释候选，需要结合调用方向、架构依赖、监控和组件健康状态确认。",
    ]
    (output / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="logfault-stream",
        description="两遍流式日志异常检测与故障链定位（事件不驻留内存）",
    )
    parser.add_argument("--input", required=True, help="日志文件、目录、ZIP 或 GZIP")
    parser.add_argument("--output", required=True, help="结果输出目录")
    parser.add_argument("--config", help="YAML 配置文件")
    parser.add_argument("--model", choices=["isolation_forest", "one_class_svm"], help="覆盖检测模型")
    parser.add_argument(
        "--reorder-seconds",
        type=float,
        default=60.0,
        help="乱序容忍窗口（秒）：文件内部轻微乱序时保证全局时间有序，默认 60",
    )
    args = parser.parse_args(argv)
    try:
        summary = run_stream_pipeline(
            input_path=args.input,
            output_dir=args.output,
            config_path=args.config,
            model_override=args.model,
            reorder_seconds=args.reorder_seconds,
        )
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:  # CLI 边界：给出可操作的错误信息
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
