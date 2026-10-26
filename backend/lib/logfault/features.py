from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


@dataclass
class WindowedData:
    metadata: pd.DataFrame
    matrix: pd.DataFrame
    # 语义特征列名（启用 embedding 时非空）；关闭时为空列表。
    embedding_columns: list[str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.embedding_columns is None:
            self.embedding_columns = []


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

    # Pandas 3 may preserve Python datetime values as datetime64[us].  Timestamp.value
    # is always nanoseconds, so normalize the array before searchsorted comparisons.
    timestamps = frame["timestamp"].astype("datetime64[ns]").astype("int64").to_numpy()
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

    # 可选：叠加模板语义特征（P2）。关闭或不可用时回退纯计数特征。
    embedding_columns: list[str] = []
    if bool(feature_config.get("embedding", {}).get("enabled", False)):
        embedding_columns, embedding_matrix = _build_embedding_features(
            frame, matrix, feature_config
        )
        if embedding_columns:
            matrix = pd.concat(
                [matrix, pd.DataFrame(embedding_matrix, index=matrix.index, columns=embedding_columns)],
                axis=1,
            )

    return WindowedData(metadata=metadata, matrix=matrix, embedding_columns=embedding_columns)


def _build_embedding_features(
    frame: pd.DataFrame,
    matrix: pd.DataFrame,
    feature_config: dict,
) -> tuple[list[str], np.ndarray]:
    """为每个窗口生成「模板语义向量加权平均」特征矩阵。

    返回 (列名列表, shape=(窗口数, dim) 的语义矩阵)；embedding 不可用时返回 ([], 空矩阵)。
    """
    try:
        from .embedding import embed_texts
    except Exception as exc:  # pragma: no cover
        logger.info("[EMBEDDING] 模块不可用，回退纯计数特征: %s", exc)
        return [], np.empty((len(matrix), 0))

    embed_config = feature_config.get("embedding", {})
    text_source = str(embed_config.get("text_source", "template")).strip().lower()

    # 特征名 → 模板文本（每个特征只编码一次）。
    feature_texts: dict[str, str] = {}
    for _, row in frame.iterrows():
        feature = str(row["feature"])
        if feature in feature_texts:
            continue
        if text_source == "raw":
            text = " ".join(
                str(row.get(k) or "")
                for k in ("message", "semantic_message", "root_cause")
            ).strip()
        else:
            text = str(row.get("template") or row.get("template_id") or "")
        if text.strip():
            feature_texts[feature] = text.strip()

    if not feature_texts:
        logger.info("[EMBEDDING] 无可编码模板文本，回退纯计数特征")
        return [], np.empty((len(matrix), 0))

    try:
        order = list(feature_texts.keys())
        vectors = embed_texts([feature_texts[k] for k in order])
    except Exception as exc:  # noqa: BLE001
        logger.info("[EMBEDDING] embedding 调用失败，回退纯计数特征: %s", exc)
        return [], np.empty((len(matrix), 0))

    feature_vec = {name: vectors[i] for i, name in enumerate(order)}

    # 可选 PCA 降维：语义向量维度可能很高，拼入前先降维避免维度爆炸。
    pca_components = int(embed_config.get("pca_components", 0) or 0)
    if pca_components > 0 and vectors.shape[1] > pca_components:
        from sklearn.decomposition import PCA

        # n_components 受样本数（模板数）与原始维度共同约束，避免模板数不足时报错。
        n_components = min(pca_components, vectors.shape[0], vectors.shape[1])
        pca = PCA(n_components=n_components, random_state=42)
        reduced = pca.fit_transform(vectors)
        feature_vec = {name: reduced[i] for i, name in enumerate(order)}

    dim = next(iter(feature_vec.values())).shape[0]
    columns = [f"emb_{i + 1:02d}" for i in range(dim)]

    # 窗口语义向量 = 该窗口内出现特征的 embedding 按计数加权平均（未出现=0）。
    counts = matrix.to_numpy(dtype=float)
    feature_cols = list(matrix.columns)
    weight = np.zeros((len(feature_cols), dim), dtype=float)
    for name, vec in feature_vec.items():
        if name in matrix.columns:
            idx = feature_cols.index(name)
            weight[idx] = vec

    totals = counts.sum(axis=1, keepdims=True)
    totals[totals == 0] = 1.0  # 避免除零（理论上不会出现，因为窗口至少 1 个事件）
    embedding_matrix = (counts @ weight) / totals

    return columns, embedding_matrix
