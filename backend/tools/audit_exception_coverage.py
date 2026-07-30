#!/usr/bin/env python3
"""Audit Incident promotion without assuming every application ERROR is a system fault."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("output_dir", help="logfault pipeline output directory")
    args = parser.parse_args()
    root = Path(args.output_dir)
    events = pd.read_csv(root / "events.csv", encoding="utf-8-sig")
    details = json.loads((root / "incident_details.json").read_text(encoding="utf-8"))

    levels = events["level"].fillna("").astype(str).str.upper()
    errors = events.loc[levels.isin(["ERROR", "FATAL"])].copy()
    errors["root_exception_class"] = errors.get("root_exception_class", "").fillna("").astype(str)
    event_classes = {value for value in errors["root_exception_class"] if value}

    mapped: dict[str, set[str]] = {}
    for detail in details:
        incident_id = str(detail.get("incident_id") or "")
        summaries = detail.get("exception_summary") or detail.get("exception_classes") or []
        for item in summaries:
            class_name = (
                str(item.get("root_exception_class") or "")
                if isinstance(item, dict)
                else str(item or "")
            )
            if class_name:
                mapped.setdefault(class_name, set()).add(incident_id)

    unassigned_path = root / "unassigned_error_events.csv"
    if unassigned_path.is_file():
        unassigned = pd.read_csv(unassigned_path, encoding="utf-8-sig")
    else:
        unassigned = pd.DataFrame()
    technical_unassigned = (
        unassigned.loc[unassigned["technical_error"].fillna(False).astype(bool)]
        if not unassigned.empty and "technical_error" in unassigned.columns
        else pd.DataFrame()
    )

    print(f"ERROR/FATAL 事件数: {len(errors)}")
    print(f"events.csv root_exception_class 种类数: {len(event_classes)}")
    print(f"进入 Incident 的 root_exception_class 种类数: {len(mapped)}")
    print(f"未提升为 Incident 的 ERROR/FATAL 事件数: {len(unassigned)}")
    print(f"其中技术故障类未归属事件数: {len(technical_unassigned)}")
    print("说明：业务校验/认证类 ERROR 未进入 Incident 并不代表漏检；Incident 表示系统故障 episode。")

    for class_name in sorted(event_classes):
        incident_ids = ", ".join(sorted(mapped.get(class_name, set()))) or "<未提升为Incident>"
        count = int((errors["root_exception_class"] == class_name).sum())
        print(f"- {class_name}: count={count}, incidents={incident_ids}")

    if not technical_unassigned.empty:
        print("\n需要重点检查的未归属技术故障事件：")
        columns = [
            column
            for column in [
                "timestamp", "service", "trace_id", "root_exception_class",
                "fault_family", "message", "source_file", "source_line",
            ]
            if column in technical_unassigned.columns
        ]
        print(technical_unassigned[columns].head(50).to_string(index=False))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
