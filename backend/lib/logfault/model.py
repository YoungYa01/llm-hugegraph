from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
from sklearn.svm import OneClassSVM


@dataclass
class ModelArtifacts:
    scaler: StandardScaler
    pca: PCA
    detector: Any
    feature_names: list[str]
    detector_type: str
    explained_variance: float
    target_variance: float


@dataclass
class DetectionResult:
    artifacts: ModelArtifacts
    standardized: np.ndarray
    embeddings: np.ndarray
    anomaly_score: np.ndarray
    is_anomaly: np.ndarray


def _align_columns(frame: pd.DataFrame, feature_names: list[str]) -> pd.DataFrame:
    return frame.reindex(columns=feature_names, fill_value=0.0)


def _fit_pca(x_train: np.ndarray, pca_config: dict) -> tuple[PCA, float]:
    max_possible = min(x_train.shape[0], x_train.shape[1])
    if max_possible < 1:
        raise ValueError("PCA 输入维度不足")
    max_components = min(int(pca_config.get("max_components", 20)), max_possible)
    pca = PCA(n_components=max_components, svd_solver="auto", random_state=42)
    pca.fit(x_train)
    explained = float(pca.explained_variance_ratio_.sum())
    return pca, explained


def fit_and_detect(
    target_features: pd.DataFrame,
    model_config: dict,
    pca_config: dict,
    train_features: pd.DataFrame | None = None,
) -> DetectionResult:
    if train_features is None:
        feature_names = target_features.columns.tolist()
        training = target_features
    else:
        feature_names = sorted(set(train_features.columns) | set(target_features.columns))
        training = _align_columns(train_features, feature_names)
        target_features = _align_columns(target_features, feature_names)

    scaler = StandardScaler()
    x_train_scaled = scaler.fit_transform(training.to_numpy(dtype=float))
    x_target_scaled = scaler.transform(target_features.to_numpy(dtype=float))

    pca, explained = _fit_pca(x_train_scaled, pca_config)
    x_train_pca = pca.transform(x_train_scaled)
    x_target_pca = pca.transform(x_target_scaled)

    detector_type = str(model_config.get("type", "isolation_forest")).lower()
    if detector_type == "isolation_forest":
        detector = IsolationForest(
            n_estimators=int(model_config.get("n_estimators", 300)),
            contamination=float(model_config.get("contamination", 0.03)),
            random_state=int(model_config.get("random_state", 42)),
            n_jobs=-1,
        )
    elif detector_type in {"one_class_svm", "ocsvm"}:
        detector = OneClassSVM(
            kernel="rbf",
            gamma=model_config.get("ocsvm_gamma", "scale"),
            nu=float(model_config.get("ocsvm_nu", 0.03)),
        )
        detector_type = "one_class_svm"
    else:
        raise ValueError(f"不支持的模型类型: {detector_type}")

    detector.fit(x_train_pca)
    predictions = detector.predict(x_target_pca)
    anomaly_score = -detector.decision_function(x_target_pca)
    is_anomaly = predictions == -1

    artifacts = ModelArtifacts(
        scaler=scaler,
        pca=pca,
        detector=detector,
        feature_names=feature_names,
        detector_type=detector_type,
        explained_variance=explained,
        target_variance=float(pca_config.get("target_variance", 0.95)),
    )
    return DetectionResult(
        artifacts=artifacts,
        standardized=x_target_scaled,
        embeddings=x_target_pca,
        anomaly_score=np.asarray(anomaly_score, dtype=float),
        is_anomaly=np.asarray(is_anomaly, dtype=bool),
    )
