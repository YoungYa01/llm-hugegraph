from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

import numpy as np
import pandas as pd


@dataclass
class WindowedData:
    metadata: pd.DataFrame
    matrix: pd.DataFrame


def _feature_name(row: pd.Series, namespace_by_service: bool) -> str:
    template = str(row["template_id"])
    if namespace_by_service:
        return f"{row['service']}::{template}"
    return template


def build_window_features(events: pd.DataFrame, window_config: dict, feature_config: dict) -> WindowedData:
    if events.empty:
        raise ValueError("事件表为空，无法构造窗口")

    frame = events.copy()
    frame["feature"] = frame.apply(
        _feature_name,
        axis=1,
        namespace_by_service=bool(feature_config.get("namespace_by_service", True)),
    )
    if feature_config.get("include_levels", False):
        frame["feature"] = frame["feature"] + "::" + frame["level"].astype(str)

    size = pd.Timedelta(minutes=int(window_config.get("size_minutes", 5)))
    step = pd.Timedelta(minutes=int(window_config.get("step_minutes", 1)))
    if size <= pd.Timedelta(0) or step <= pd.Timedelta(0):
        raise ValueError("窗口大小和步长必须大于 0")

    min_time = frame["timestamp"].min().floor(f"{int(step.total_seconds())}s")
    max_time = frame["timestamp"].max().ceil(f"{int(step.total_seconds())}s")
    starts = pd.date_range(start=min_time, end=max_time, freq=step)
    features = sorted(frame["feature"].unique().tolist())
    feature_index = {name: index for index, name in enumerate(features)}

    timestamps = frame["timestamp"].astype("int64").to_numpy()
    order = np.argsort(timestamps)
    timestamps = timestamps[order]
    sorted_features = frame["feature"].to_numpy()[order]

    rows: list[np.ndarray] = []
    metadata_rows: list[dict] = []
    min_events = int(window_config.get("min_events", 1))

    for start in starts:
        end = start + size
        left = int(np.searchsorted(timestamps, start.value, side="left"))
        right = int(np.searchsorted(timestamps, end.value, side="left"))
        event_count = right - left
        if event_count < min_events:
            continue
        vector = np.zeros(len(features), dtype=float)
        for feature in sorted_features[left:right]:
            vector[feature_index[str(feature)]] += 1.0
        rows.append(vector)
        metadata_rows.append(
            {
                "window_id": f"W{len(metadata_rows) + 1:06d}",
                "window_start": start,
                "window_end": end,
                "event_count": event_count,
            }
        )

    if not rows:
        raise ValueError("没有生成有效窗口，请检查时间戳或 min_events 配置")

    matrix = pd.DataFrame(np.vstack(rows), columns=features)
    metadata = pd.DataFrame(metadata_rows)
    return WindowedData(metadata=metadata, matrix=matrix)
