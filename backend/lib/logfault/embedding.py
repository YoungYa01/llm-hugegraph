from __future__ import annotations

import logging
import os
from typing import Any

import numpy as np

try:
    import requests
except Exception:  # pragma: no cover
    requests = None

logger = logging.getLogger(__name__)


def _embedding_base_url() -> str:
    return os.getenv("LLM_BASE_URL", "").strip().rstrip("/")


def _embedding_model() -> str:
    return (
        os.getenv("LLM_EMBEDDING_MODEL", "").strip()
        or os.getenv("LLM_MODEL", "").strip()
    )


def embed_texts(texts: list[str], dim: int | None = None) -> np.ndarray:
    """对一批文本调用 LLM 网关的 embeddings 接口，返回 shape=(n, dim) 的 float 矩阵。

    网关不可用、未配置或返回异常时抛出 RuntimeError，由调用方降级为纯计数特征。
    """
    if requests is None:
        raise RuntimeError("requests 未安装，无法调用 embeddings 接口")
    if not texts:
        raise RuntimeError("待编码文本为空")

    base_url = _embedding_base_url()
    if not base_url:
        raise RuntimeError("LLM_BASE_URL 未配置，无法调用 embeddings 接口")

    # OpenAI 兼容：/v1/embeddings；若 base_url 已含 /v1 则直接拼 /embeddings。
    if base_url.endswith("/v1"):
        url = f"{base_url}/embeddings"
    else:
        url = f"{base_url}/v1/embeddings"

    model = _embedding_model()
    if not model:
        raise RuntimeError("LLM_EMBEDDING_MODEL / LLM_MODEL 未配置")

    api_key = os.getenv("LLM_API_KEY", "not-needed").strip() or "not-needed"
    payload: dict[str, Any] = {
        "model": model,
        "input": texts,
        "encoding_format": "float",
    }
    if dim is not None and dim > 0:
        payload["dimensions"] = int(dim)
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    timeout = (
        int(os.getenv("LLM_CONNECT_TIMEOUT_SECONDS", "10")),
        int(os.getenv("LLM_EMBEDDING_TIMEOUT_SECONDS", "60")),
    )
    response = requests.post(url, json=payload, headers=headers, timeout=timeout)
    if response.status_code >= 400:
        raise RuntimeError(f"embeddings HTTP {response.status_code}: {response.text[:500]}")

    data = response.json()
    try:
        items = data["data"]
        # OpenAI 兼容返回按 index 排序。
        items = sorted(items, key=lambda item: int(item.get("index", 0)))
        vectors = [item["embedding"] for item in items]
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(f"embeddings 返回格式异常: {exc}") from exc

    if len(vectors) != len(texts):
        raise RuntimeError(f"embeddings 返回数量 {len(vectors)} != 请求 {len(texts)}")

    matrix = np.asarray(vectors, dtype=float)
    if matrix.ndim != 2:
        raise RuntimeError("embeddings 返回维度异常")
    return matrix
