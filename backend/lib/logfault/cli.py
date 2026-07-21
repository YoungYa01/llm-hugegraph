from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

from .pipeline import run_pipeline


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="logfault",
        description="Spring 微服务日志异常检测与故障链定位",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    analyze = subparsers.add_parser("analyze", help="运行完整分析流程")
    analyze.add_argument("--input", required=True, help="单个 .log、日志目录或 ZIP")
    analyze.add_argument("--output", required=True, help="结果输出目录")
    analyze.add_argument("--config", help="YAML 配置文件")
    analyze.add_argument(
        "--train-input",
        help="可选：确认正常的训练日志目录/ZIP；不提供时在目标数据上无监督训练",
    )
    analyze.add_argument(
        "--model",
        choices=["isolation_forest", "one_class_svm"],
        help="覆盖配置中的异常检测模型",
    )

    trace = subparsers.add_parser("trace", help="从 events.csv 查看某个 traceId 的跨服务时间线")
    trace.add_argument("--events", required=True, help="分析结果中的 events.csv")
    trace.add_argument("--trace-id", required=True, help="需要检索的 traceId")
    trace.add_argument("--json", action="store_true", help="以 JSON 输出")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "analyze":
            summary = run_pipeline(
                input_path=args.input,
                output_dir=args.output,
                config_path=args.config,
                train_input=args.train_input,
                model_override=args.model,
            )
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            return 0
        if args.command == "trace":
            events_path = Path(args.events)
            if not events_path.exists():
                raise FileNotFoundError(f"events.csv 不存在: {events_path}")
            events = pd.read_csv(events_path, encoding="utf-8-sig", dtype={"trace_id": str})
            timeline = events.loc[events["trace_id"].fillna("").astype(str) == str(args.trace_id)].copy()
            if timeline.empty:
                raise ValueError(f"没有找到 traceId={args.trace_id}")
            timeline = timeline.sort_values(["timestamp", "source_file", "source_line"])
            columns = [
                "timestamp", "level", "service", "instance", "logger", "message",
                "root_cause", "template_id", "source_file", "source_line",
            ]
            timeline = timeline[[column for column in columns if column in timeline.columns]]
            if args.json:
                print(json.dumps(timeline.fillna("").to_dict(orient="records"), ensure_ascii=False, indent=2))
            else:
                print(timeline.fillna("").to_string(index=False))
            return 0
        return 2
    except Exception as exc:  # CLI boundary: provide concise actionable error.
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
