from __future__ import annotations

import re
import warnings
from dataclasses import dataclass
from typing import Iterable

import pandas as pd


@dataclass
class TemplateRecord:
    template_id: str
    template: str
    occurrences: int


class SimpleDrainFallback:
    """Small deterministic Drain-like fallback used only when drain3 is unavailable.

    It masks configured variables, buckets by token count, and merges messages when
    token similarity exceeds the configured threshold. Production use should install
    drain3; the fallback keeps the project runnable in restricted/offline environments.
    """

    def __init__(self, similarity_threshold: float, mask_patterns: list[str]) -> None:
        self.threshold = similarity_threshold
        self.patterns = [re.compile(pattern) for pattern in mask_patterns]
        self.clusters: list[list[str]] = []
        self.counts: list[int] = []

    def _mask(self, text: str) -> str:
        value = text
        for pattern in self.patterns:
            value = pattern.sub("<*>", value)
        return re.sub(r"\s+", " ", value).strip()

    @staticmethod
    def _similarity(a: list[str], b: list[str]) -> float:
        if len(a) != len(b) or not a:
            return 0.0
        matches = sum(x == y or x == "<*>" or y == "<*>" for x, y in zip(a, b))
        return matches / len(a)

    @staticmethod
    def _merge(a: list[str], b: list[str]) -> list[str]:
        return [x if x == y else "<*>" for x, y in zip(a, b)]

    def add(self, message: str) -> tuple[str, str]:
        tokens = self._mask(message).split()
        best_index = -1
        best_similarity = -1.0
        for index, template_tokens in enumerate(self.clusters):
            similarity = self._similarity(tokens, template_tokens)
            if similarity > best_similarity:
                best_index = index
                best_similarity = similarity
        if best_index >= 0 and best_similarity >= self.threshold:
            self.clusters[best_index] = self._merge(self.clusters[best_index], tokens)
            self.counts[best_index] += 1
            return f"E{best_index + 1:05d}", " ".join(self.clusters[best_index])
        self.clusters.append(tokens)
        self.counts.append(1)
        index = len(self.clusters) - 1
        return f"E{index + 1:05d}", " ".join(tokens)


class DrainParser:
    def __init__(self, config: dict) -> None:
        self.config = config
        self.backend = "fallback"
        self._miner = None
        self._fallback = None
        requested = config.get("backend", "drain3").lower()
        if requested == "drain3":
            try:
                from drain3 import TemplateMiner
                from drain3.masking import MaskingInstruction
                from drain3.template_miner_config import TemplateMinerConfig

                miner_config = TemplateMinerConfig()
                miner_config.drain_sim_th = float(config.get("similarity_threshold", 0.4))
                miner_config.drain_depth = int(config.get("depth", 4))
                miner_config.drain_max_children = int(config.get("max_children", 100))
                miner_config.drain_max_clusters = int(config.get("max_clusters", 10000))
                miner_config.masking_instructions = [
                    MaskingInstruction(pattern, "VAR")
                    for pattern in config.get("mask_patterns", [])
                ]
                self._miner = TemplateMiner(config=miner_config)
                self.backend = "drain3"
            except ImportError:
                warnings.warn(
                    "未安装 drain3，暂时使用内置 Drain-like fallback。"
                    "执行 pip install -r requirements.txt 后会自动使用官方 drain3。",
                    RuntimeWarning,
                )

        if self._miner is None:
            self._fallback = SimpleDrainFallback(
                similarity_threshold=float(config.get("similarity_threshold", 0.4)),
                mask_patterns=list(config.get("mask_patterns", [])),
            )

    def add(self, message: str) -> tuple[str, str]:
        if self._miner is not None:
            result = self._miner.add_log_message(message)
            cluster_id = int(result["cluster_id"])
            return f"E{cluster_id:05d}", str(result["template_mined"])
        assert self._fallback is not None
        return self._fallback.add(message)


def template_events(events: pd.DataFrame, config: dict) -> tuple[pd.DataFrame, pd.DataFrame, str]:
    parser = DrainParser(config)
    template_ids: list[str] = []
    templates: list[str] = []
    counts: dict[tuple[str, str], int] = {}

    for message in events["semantic_message"].fillna("").astype(str):
        template_id, template = parser.add(message)
        template_ids.append(template_id)
        templates.append(template)
        counts[(template_id, template)] = counts.get((template_id, template), 0) + 1

    result = events.copy()
    result["template_id"] = template_ids
    result["template"] = templates

    rows = [
        {"template_id": key[0], "template": key[1], "occurrences": value}
        for key, value in counts.items()
    ]
    template_frame = pd.DataFrame(rows).sort_values(
        ["occurrences", "template_id"], ascending=[False, True]
    ).reset_index(drop=True)
    return result, template_frame, parser.backend
