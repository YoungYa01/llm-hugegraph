from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd

from .config import load_config
from .drain_adapter import template_events
from .explain import annotate_windows, merge_anomaly_windows
from .features import build_window_features
from .ingest import load_events
from .model import fit_and_detect


def _save_frame(frame: pd.DataFrame, path: Path) -> None:
    export = frame.copy()
    for column in export.columns:
        if pd.api.types.is_datetime64_any_dtype(export[column]):
            export[column] = export[column].astype(str)
    export.to_csv(path, index=False, encoding="utf-8-sig")


def _report(
    output_dir: Path,
    config: dict[str, Any],
    parser_backend: str,
    events: pd.DataFrame,
    templates: pd.DataFrame,
    windows: pd.DataFrame,
    incidents: pd.DataFrame,
    explained_variance: float,
    component_count: int,
) -> None:
    anomaly_count = int(windows["is_anomaly"].sum())
    variance_target = float(config["pca"].get("target_variance", 0.95))
    variance_note = (
        "达到目标"
        if explained_variance >= variance_target
        else "未达到目标；20 维上限或样本维度限制导致信息保留不足"
    )
    lines = [
        "# 日志异常检测与故障定位报告",
        "",
        "## 运行概览",
        "",
        f"- Drain 后端：`{parser_backend}`",
        f"- 解析事件数：{len(events)}",
        f"- 日志模板数：{len(templates)}",
        f"- 滑动窗口数：{len(windows)}",
        f"- 异常窗口数：{anomaly_count}",
        f"- 合并故障区间数：{len(incidents)}",
        f"- PCA 维数：{component_count}",
        f"- PCA 累计解释方差：{explained_variance:.4f}（目标 {variance_target:.2f}，{variance_note}）",
        "",
        "## 结果文件",
        "",
        "- `events.csv`：结构化日志、模板、traceId 和原始异常栈。",
        "- `templates.csv`：Drain 模板清单。",
        "- `window_features.csv`：每个窗口内各服务模板频率。",
        "- `window_embeddings.csv`：PCA 向量和异常分数。",
        "- `anomaly_windows.csv`：异常窗口及高贡献模板。",
        "- `incidents.csv`：合并后的故障时间段和根因候选。",
        "- `incident_details.json`：候选根因和跨服务时间线。",
        "- `model_artifacts.joblib`：StandardScaler、PCA 和检测模型。",
        "",
        "## 注意",
        "",
        "异常检测负责发现异常时间段；根因字段是启发式候选，需要结合 traceId、调用方向和异常堆栈确认。",
    ]
    (output_dir / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_pipeline(
    input_path: str | Path,
    output_dir: str | Path,
    config_path: str | Path | None = None,
    train_input: str | Path | None = None,
    model_override: str | None = None,
) -> dict[str, Any]:
    config = load_config(config_path)
    if model_override:
        config["model"]["type"] = model_override

    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)

    target_events = load_events(input_path, config["input"])
    target_events, templates, parser_backend = template_events(target_events, config["parser"])
    target_windowed = build_window_features(target_events, config["window"], config["features"])

    train_features = None
    if train_input is not None:
        train_events = load_events(train_input, config["input"])
        # 为了共享同一模板空间，把训练日志先与目标日志合并后统一 Drain，再拆分。
        train_events = train_events.copy()
        target_copy = target_events.drop(columns=["template_id", "template"]).copy()
        train_events["__dataset"] = "train"
        target_copy["__dataset"] = "target"
        combined = pd.concat([train_events, target_copy], ignore_index=True)
        combined, combined_templates, parser_backend = template_events(combined, config["parser"])
        train_templated = combined.loc[combined["__dataset"] == "train"].drop(columns="__dataset")
        target_events = combined.loc[combined["__dataset"] == "target"].drop(columns="__dataset")
        templates = combined_templates
        train_windowed = build_window_features(train_templated, config["window"], config["features"])
        target_windowed = build_window_features(target_events, config["window"], config["features"])
        train_features = train_windowed.matrix

    detection = fit_and_detect(
        target_features=target_windowed.matrix,
        train_features=train_features,
        model_config=config["model"],
        pca_config=config["pca"],
    )

    aligned_target_matrix = target_windowed.matrix.reindex(
        columns=detection.artifacts.feature_names, fill_value=0.0
    )

    annotated_windows = annotate_windows(
        metadata=target_windowed.metadata,
        feature_matrix=aligned_target_matrix,
        standardized=detection.standardized,
        scores=detection.anomaly_score,
        flags=detection.is_anomaly,
        events=target_events,
        explain_config=config["explain"],
    )
    incidents, incident_details = merge_anomaly_windows(
        annotated_windows, target_events, config["explain"]
    )

    _save_frame(target_events, output / "events.csv")
    _save_frame(templates, output / "templates.csv")

    window_features = pd.concat([target_windowed.metadata, aligned_target_matrix], axis=1)
    _save_frame(window_features, output / "window_features.csv")

    embedding_columns = [f"pc_{index + 1:02d}" for index in range(detection.embeddings.shape[1])]
    embeddings = pd.DataFrame(detection.embeddings, columns=embedding_columns)
    embeddings = pd.concat(
        [
            target_windowed.metadata.reset_index(drop=True),
            embeddings,
            pd.DataFrame(
                {
                    "anomaly_score": detection.anomaly_score,
                    "is_anomaly": detection.is_anomaly,
                }
            ),
        ],
        axis=1,
    )
    _save_frame(embeddings, output / "window_embeddings.csv")
    _save_frame(annotated_windows, output / "anomaly_windows.csv")
    _save_frame(incidents, output / "incidents.csv")
    (output / "incident_details.json").write_text(
        json.dumps(incident_details, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (output / "effective_config.json").write_text(
        json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    joblib.dump(detection.artifacts, output / "model_artifacts.joblib")

    _report(
        output_dir=output,
        config=config,
        parser_backend=parser_backend,
        events=target_events,
        templates=templates,
        windows=annotated_windows,
        incidents=incidents,
        explained_variance=detection.artifacts.explained_variance,
        component_count=detection.embeddings.shape[1],
    )

    summary = {
        "input": str(input_path),
        "output": str(output),
        "parser_backend": parser_backend,
        "events": len(target_events),
        "templates": len(templates),
        "windows": len(annotated_windows),
        "anomaly_windows": int(annotated_windows["is_anomaly"].sum()),
        "incidents": len(incidents),
        "pca_components": detection.embeddings.shape[1],
        "pca_explained_variance": detection.artifacts.explained_variance,
        "model": detection.artifacts.detector_type,
    }
    (output / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return summary
