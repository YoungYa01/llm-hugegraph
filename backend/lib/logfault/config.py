from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any

import yaml


DEFAULT_CONFIG: dict[str, Any] = {
    "input": {
        "include_globs": ["**/*.log"],
        "exclude_globs": ["**/*-err.log", "**/*-debug.log"],
        "encoding": "utf-8",
        "encoding_errors": "replace",
    },
    "parser": {
        "backend": "drain3",
        "similarity_threshold": 0.4,
        "depth": 4,
        "max_children": 100,
        "max_clusters": 10000,
        "mask_patterns": [
            r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b",
            r"(?i)\b(?:[0-9a-f]{8,})\b",
            r"\b(?:\d{1,3}\.){3}\d{1,3}\b",
            r"\b\d+ms\b",
            r"\b\d+(?:\.\d+)?\b",
        ],
    },
    "window": {"size_minutes": 5, "step_minutes": 1, "min_events": 1},
    "features": {"namespace_by_service": True, "include_levels": False},
    "pca": {"max_components": 20, "target_variance": 0.95},
    "model": {
        "type": "isolation_forest",
        "contamination": 0.03,
        "n_estimators": 300,
        "random_state": 42,
        "ocsvm_nu": 0.03,
        "ocsvm_gamma": "scale",
    },
    "explain": {
        "top_templates": 10,
        "top_trace_ids": 10,
        "max_timeline_events": 200,
        "merge_gap_minutes": 1,
    },
}


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_config(path: str | Path | None) -> dict[str, Any]:
    if path is None:
        return deepcopy(DEFAULT_CONFIG)
    config_path = Path(path)
    if not config_path.exists():
        raise FileNotFoundError(f"配置文件不存在: {config_path}")
    with config_path.open("r", encoding="utf-8") as handle:
        user_config = yaml.safe_load(handle) or {}
    if not isinstance(user_config, dict):
        raise ValueError("配置文件根节点必须是映射对象")
    return _deep_merge(DEFAULT_CONFIG, user_config)
