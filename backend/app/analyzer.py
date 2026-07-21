from __future__ import annotations

import json
import os
import re
import urllib.parse
from typing import Any

import requests

try:
    from json_repair import repair_json
except Exception:  # pragma: no cover
    def repair_json(text: str) -> str:
        return text

from .config import get_settings
from .models import ExtractedCall, ExtractedGraph, ExtractedNode


ALLOWED_KINDS = {
    "System", "Layer", "Service", "Database", "Cache", "Middleware", "Queue", "API", "Function", "Component",
    "Cluster", "Instance", "Incident", "Trace", "LogEvent", "Exception", "Window", "Metric", "Host", "Pod",
    "RCAHypothesis", "UnresolvedDependency",
}
ALLOWED_RELATIONS = {
    "CALLS",
    "USES_DB",
    "CONTAINS",
    "BELONGS_TO_LAYER",
    "PROVIDES",
    "DEPENDS_ON",
    "READS",
    "WRITES",
    "PUBLISHES",
    "SUBSCRIBES",
    "HAS_MEMBER",
    "RUNS_ON",
    "CONNECTS_TO",
    "HAS_TRACE", "HAS_EVENT", "OBSERVED_IN", "ROOT_CAUSE", "ROOT_SERVICE", "EMITS",
    "CAUSES", "PROPAGATES_TO", "ERROR_PROPAGATES_TO", "TRIGGERED_BY", "AFFECTS",
    "OBSERVED_AT", "HAS_EXCEPTION", "HAS_HYPOTHESIS", "CANDIDATE_CAUSE", "SUSPECTED_ROOT_CAUSE",
    "SUPPORTED_BY", "TEMPORALLY_PRECEDES", "CO_OCCURS_IN_TRACE",
}


def _list_values(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return [str(item) for item in value if str(item).strip()]
    return [str(value)] if str(value).strip() else []


SYSTEM_PROMPT = """
你是系统架构知识图谱抽取器。禁止输出思考过程，只输出一个 JSON 对象。

JSON 格式固定为：
{"services":[{"name":"节点名","layer":"层级","kind":"Service|Database|Cache|Middleware|Queue|API|Function|Layer|System|Component|Cluster|Instance|Host|Pod","description":"描述","meta":{"aliases":[],"host":"","port":""}}],"calls":[{"source":"起点节点名","target":"终点节点名","type":"CALLS|USES_DB|CONTAINS|BELONGS_TO_LAYER|PROVIDES|DEPENDS_ON|READS|WRITES|PUBLISHES|SUBSCRIBES|HAS_MEMBER|RUNS_ON|CONNECTS_TO","description":"描述","meta":{}}]}

规则：
1. 文档里的系统、层、服务、数据库、中间件、队列、接口、功能都要作为 services 节点。
2. calls 中的 source 和 target 必须能在 services 里找到。
3. 集群和实例必须分开建模，例如“Redis集群 -HAS_MEMBER-> redis-1”；服务依赖基础设施用 DEPENDS_ON。
4. 文档给出别名、主机名、IP、端口时放入 meta；未给出的信息禁止猜测。
5. 不要 Markdown，不要代码块，不要解释，不要 <think>。
""".strip()


class LLMAnalyzer:
    """Architecture extractor.

    Production rule for this demo: /api/import must not fail just because the
    local model is slow, returns Qwen reasoning_content only, or returns invalid
    JSON. We try the local OpenAI-compatible endpoint first, then optional
    LangChain, then llama.cpp /completion, and finally a deterministic extractor.
    """

    def __init__(self) -> None:
        self.settings = get_settings()
        self.api_key = (self.settings.llm_api_key or "not-needed").strip() or "not-needed"
        self.last_logs: list[str] = []
        self.last_mode = "unknown"
        self.last_error = ""
        self.session = requests.Session()
        if self.settings.llm_disable_env_proxy:
            # Local LLM/HugeGraph calls must not be routed through corporate/system
            # proxies. The user's 502 happened exactly in this area.
            self.session.trust_env = False
            self._patch_no_proxy_env()

        # Local OpenAI-compatible servers do not validate this, but SDKs do.
        os.environ["OPENAI_API_KEY"] = os.getenv("OPENAI_API_KEY") or self.api_key
        os.environ["OPENAI_ADMIN_KEY"] = os.getenv("OPENAI_ADMIN_KEY") or self.api_key

    def analyze_architecture(self, text: str) -> dict[str, Any]:
        self.last_logs = []
        self.last_mode = "unknown"
        self.last_error = ""

        user_text = text.strip()
        if not user_text:
            self.last_mode = "empty"
            return ExtractedGraph().model_dump()

        errors: list[str] = []

        if self.settings.llm_enabled:
            # Direct HTTP first. It is closer to the user's test.py and avoids
            # LangChain/httpx proxy surprises by using Session(trust_env=False).
            try:
                result = self._analyze_with_openai_http(user_text)
                self.last_mode = "llm-openai-http"
                return result
            except Exception as exc:  # noqa: BLE001
                msg = str(exc)
                errors.append(f"OpenAI兼容HTTP失败: {msg}")
                self.last_logs.append(errors[-1])
                # Qwen3 can spend the whole response budget in reasoning_content,
                # leaving content empty. Retrying other adapters usually repeats
                # the same failure and wastes minutes, so fall back immediately.
                if "被截断的思考" in msg or "reasoning_content" in msg or "finish_reason=length" in msg:
                    self.last_error = " | ".join(errors)
                    self.last_mode = "rule-fallback"
                    fallback = RuleBasedArchitectureExtractor().extract(user_text)
                    self.last_logs.append("模型返回思考过程而不是 JSON，已立即切换规则兜底抽取。")
                    return fallback.model_dump()

            if self.settings.llm_use_langchain_first:
                try:
                    result = self._analyze_with_langchain(user_text)
                    self.last_mode = "llm-langchain"
                    return result
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"LangChain失败: {exc}")
                    self.last_logs.append(errors[-1])

            try:
                result = self._analyze_with_llamacpp_completion(user_text)
                self.last_mode = "llm-llamacpp-completion"
                return result
            except Exception as exc:  # noqa: BLE001
                errors.append(f"llama.cpp /completion失败: {exc}")
                self.last_logs.append(errors[-1])

        self.last_error = " | ".join(errors)
        self.last_mode = "rule-fallback"
        fallback = RuleBasedArchitectureExtractor().extract(user_text)
        self.last_logs.append(
            "已启用规则兜底抽取：本地大模型没有返回可用 JSON，但导入流程不会中断。"
        )
        if self.last_error:
            self.last_logs.append("LLM失败详情：" + self.last_error[:2000])
        return fallback.model_dump()

    def _patch_no_proxy_env(self) -> None:
        parsed = urllib.parse.urlparse(self.settings.llm_base_url)
        host = parsed.hostname or "127.0.0.1"
        values = [
            "127.0.0.1",
            "localhost",
            "::1",
            host,
            "host.docker.internal",
        ]
        old = os.getenv("NO_PROXY") or os.getenv("no_proxy") or ""
        merged: list[str] = []
        for item in [*old.split(","), *values]:
            item = item.strip()
            if item and item not in merged:
                merged.append(item)
        os.environ["NO_PROXY"] = ",".join(merged)
        os.environ["no_proxy"] = os.environ["NO_PROXY"]

    def _build_user_prompt(self, doc_text: str) -> str:
        prefix = ""
        if self.settings.llm_disable_thinking:
            prefix = "/no_think\n"
        return (
            f"{prefix}请从下面系统文档抽取知识图谱。只返回 JSON 对象，禁止解释，禁止思考过程。\n\n"
            f"系统文档：\n{doc_text}\n\nJSON："
        )

    def _chat_payloads(self, user_text: str) -> list[dict[str, Any]]:
        base_payload = {
            "model": self.settings.llm_model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": self._build_user_prompt(user_text)},
            ],
            "temperature": 0,
            "max_tokens": self.settings.llm_max_tokens,
            "stream": False,
        }
        payloads = []
        if self.settings.llm_disable_thinking:
            # llama.cpp/Qwen3 recognizes this. Other local servers usually ignore
            # unknown fields; if one rejects it, the next payload is plain OpenAI.
            payloads.append({**base_payload, "chat_template_kwargs": {"enable_thinking": False}})
        payloads.append(base_payload)
        return payloads

    def _analyze_with_openai_http(self, user_text: str) -> dict[str, Any]:
        errors: list[str] = []
        chat_urls: list[str] = []
        for base in [self.settings.llm_openai_base_url, normalize_openai_base_url(self.settings.llm_base_url)]:
            url = f"{base.rstrip('/')}/chat/completions"
            if url not in chat_urls:
                chat_urls.append(url)

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }
        for url in chat_urls:
            for payload in self._chat_payloads(user_text):
                try:
                    content = self._post_chat_completion(url, payload, headers)
                    parsed = self._parse_json_lenient(content)
                    return self._normalize_graph(parsed).model_dump()
                except Exception as exc:  # noqa: BLE001
                    msg = str(exc)
                    errors.append(f"{url}: {msg}")
                    if "被截断的思考" in msg or "finish_reason=length" in msg:
                        raise RuntimeError(msg) from exc
        raise RuntimeError("; ".join(errors))

    def _post_chat_completion(self, url: str, payload: dict[str, Any], headers: dict[str, str]) -> str:
        response = self.session.post(
            url,
            json=payload,
            headers=headers,
            timeout=(self.settings.llm_connect_timeout_seconds, self.settings.llm_timeout_seconds),
        )
        if response.status_code >= 400:
            raise RuntimeError(f"HTTP {response.status_code}: {response.text[:2000]}")
        if not response.text.strip():
            raise RuntimeError("HTTP 200 但响应体为空")
        try:
            data = response.json()
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"响应不是 JSON: {response.text[:1000]}") from exc

        try:
            message = data["choices"][0]["message"]
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"响应 JSON 中没有 choices[0].message: {json.dumps(data, ensure_ascii=False)[:1000]}") from exc

        content_candidates = [message.get("content"), message.get("reasoning_content")]
        content = "\n".join(self._content_to_text(x) for x in content_candidates if self._content_to_text(x).strip()).strip()
        finish_reason = str((data.get("choices") or [{}])[0].get("finish_reason") or "")
        if not content:
            raise RuntimeError(f"模型返回内容为空 finish_reason={finish_reason}: {json.dumps(data, ensure_ascii=False)[:1200]}")
        if finish_reason == "length" and "{" not in content:
            raise RuntimeError("模型只返回了被截断的思考过程，没有 JSON；将切换兜底抽取")
        return content

    def _analyze_with_llamacpp_completion(self, user_text: str) -> dict[str, Any]:
        completion_url = f"{self.settings.llm_base_url.rstrip('/')}/completion"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }
        prompt = f"{SYSTEM_PROMPT}\n\n{self._build_user_prompt(user_text)}"
        payloads = []
        if self.settings.llm_disable_thinking:
            payloads.append(
                {
                    "prompt": prompt,
                    "n_predict": self.settings.llm_max_tokens,
                    "temperature": 0,
                    "stream": False,
                    "chat_template_kwargs": {"enable_thinking": False},
                }
            )
        payloads.append({"prompt": prompt, "n_predict": self.settings.llm_max_tokens, "temperature": 0, "stream": False})

        errors: list[str] = []
        for payload in payloads:
            try:
                response = self.session.post(
                    completion_url,
                    json=payload,
                    headers=headers,
                    timeout=(self.settings.llm_connect_timeout_seconds, self.settings.llm_timeout_seconds),
                )
                if response.status_code >= 400:
                    raise RuntimeError(f"HTTP {response.status_code}: {response.text[:2000]}")
                if not response.text.strip():
                    raise RuntimeError("HTTP 200 但响应体为空")
                data = response.json()
                content = self._content_to_text(data.get("content") or data.get("response") or data.get("text") or data)
                parsed = self._parse_json_lenient(content)
                return self._normalize_graph(parsed).model_dump()
            except Exception as exc:  # noqa: BLE001
                errors.append(str(exc))
        raise RuntimeError("; ".join(errors))

    def _create_chat_openai(self):
        from langchain_openai import ChatOpenAI

        kwargs: dict[str, Any] = {
            "model": self.settings.llm_model,
            "base_url": self.settings.llm_openai_base_url,
            "api_key": self.api_key,
            "temperature": 0,
            "max_tokens": self.settings.llm_max_tokens,
            "timeout": self.settings.llm_timeout_seconds,
            "max_retries": 0,
        }
        if self.settings.llm_disable_env_proxy:
            try:
                import httpx

                kwargs["http_client"] = httpx.Client(
                    trust_env=False,
                    timeout=httpx.Timeout(
                        self.settings.llm_timeout_seconds,
                        connect=self.settings.llm_connect_timeout_seconds,
                    ),
                )
            except Exception:
                pass
        return ChatOpenAI(**kwargs)

    def _analyze_with_langchain(self, user_text: str) -> dict[str, Any]:
        from langchain_core.messages import HumanMessage, SystemMessage

        llm = self._create_chat_openai()
        raw_message = llm.invoke(
            [
                SystemMessage(content=SYSTEM_PROMPT),
                HumanMessage(content=self._build_user_prompt(user_text)),
            ]
        )
        content = getattr(raw_message, "content", "") or str(raw_message)
        parsed = self._parse_json_lenient(content)
        return self._normalize_graph(parsed).model_dump()

    def _content_to_text(self, value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            parts: list[str] = []
            for item in value:
                if isinstance(item, dict):
                    parts.append(self._content_to_text(item.get("text") or item.get("content") or item.get("value") or item))
                else:
                    parts.append(self._content_to_text(item))
            return "\n".join(p for p in parts if p)
        if isinstance(value, dict):
            for key in ("content", "response", "text", "message"):
                if key in value:
                    return self._content_to_text(value[key])
            return json.dumps(value, ensure_ascii=False)
        return str(value)

    def _parse_json_lenient(self, content: Any) -> dict[str, Any] | list[Any]:
        text = self._content_to_text(content).strip()
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE).strip()
        text = re.sub(r"^```(?:json)?", "", text).strip()
        text = re.sub(r"```$", "", text).strip()
        # Prefer object output, but accept arrays and normalize below.
        obj_start = text.find("{")
        obj_end = text.rfind("}")
        arr_start = text.find("[")
        arr_end = text.rfind("]")
        if obj_start >= 0 and obj_end >= obj_start:
            candidate = text[obj_start : obj_end + 1]
        elif arr_start >= 0 and arr_end >= arr_start:
            candidate = text[arr_start : arr_end + 1]
        else:
            candidate = text
        if not candidate.strip():
            raise ValueError("模型输出为空，无法解析 JSON")
        try:
            return json.loads(candidate)
        except Exception:
            repaired = repair_json(candidate)
            if not str(repaired).strip():
                raise ValueError(f"JSON 修复后仍为空。原始输出前 1000 字: {text[:1000]}")
            return json.loads(repaired)

    def _normalize_graph(self, data: Any) -> ExtractedGraph:
        if isinstance(data, list):
            data = self._normalize_list_output(data)
        if not isinstance(data, dict):
            raise ValueError(f"模型输出不是 JSON 对象: {type(data)}")

        services_raw = data.get("services") or data.get("nodes") or data.get("vertices") or []
        calls_raw = data.get("calls") or data.get("edges") or data.get("relations") or []

        node_map: dict[str, ExtractedNode] = {}
        for item in services_raw:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or item.get("id") or item.get("label") or "").strip()
            if not name:
                continue
            node_map[name] = ExtractedNode(
                name=name,
                layer=str(item.get("layer") or item.get("layer_type") or "Component层").strip() or "Component层",
                kind=self._safe_kind(str(item.get("kind") or item.get("type") or "Component")),
                description=str(item.get("description") or item.get("desc") or "").strip(),
                meta=item.get("meta") if isinstance(item.get("meta"), dict) else {},
            )

        calls: list[ExtractedCall] = []
        for item in calls_raw:
            if not isinstance(item, dict):
                continue
            source = str(item.get("source") or item.get("from") or item.get("out") or item.get("outV") or "").strip()
            target = str(item.get("target") or item.get("to") or item.get("in") or item.get("inV") or "").strip()
            if not source or not target or source == target:
                continue
            if source not in node_map:
                node_map[source] = ExtractedNode(name=source, layer="Component层", kind="Component")
            if target not in node_map:
                node_map[target] = ExtractedNode(name=target, layer="Component层", kind="Component")
            calls.append(
                ExtractedCall(
                    source=source,
                    target=target,
                    type=self._safe_relation(str(item.get("type") or item.get("relation_type") or "CALLS")),
                    description=str(item.get("description") or item.get("desc") or "").strip(),
                    meta=item.get("meta") if isinstance(item.get("meta"), dict) else {},
                )
            )

        graph = ExtractedGraph(services=list(node_map.values()), calls=calls)
        if not graph.services:
            raise ValueError("模型 JSON 中没有可用节点")
        return graph

    def _normalize_list_output(self, data: list[Any]) -> dict[str, Any]:
        services: list[dict[str, Any]] = []
        calls: list[dict[str, Any]] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            if any(k in item for k in ("source", "target", "from", "to", "outV", "inV")):
                calls.append(item)
            else:
                services.append(item)
        return {"services": services, "calls": calls}

    @staticmethod
    def _safe_kind(value: str) -> str:
        value = value.strip()
        return value if value in ALLOWED_KINDS else "Component"

    @staticmethod
    def _safe_relation(value: str) -> str:
        value = value.strip().upper()
        return value if value in ALLOWED_RELATIONS else "CALLS"


class RuleBasedArchitectureExtractor:
    SERVICE_RE = re.compile(r"[\u4e00-\u9fa5A-Za-z0-9_\-]+服务(?!名)")
    DB_RE = re.compile(r"[\u4e00-\u9fa5A-Za-z0-9_\-]+(?:数据库|DB|db)")
    LAYER_RE = re.compile(r"[\u4e00-\u9fa5A-Za-z0-9_\-]+层")
    API_RE = re.compile(r"(?:API\s*Gateway|API网关|网关|[A-Za-z0-9_\-/]+API)", re.IGNORECASE)
    QUEUE_RE = re.compile(r"Kafka|RabbitMQ|RocketMQ|MQ|消息队列", re.IGNORECASE)
    CACHE_RE = re.compile(
        r"(?:Redis|Memcached)[\u4e00-\u9fa5A-Za-z0-9_-]{0,12}?(?:集群|Cluster|缓存)|"
        r"\b(?:Redis|Memcached)\b(?![-_](?:node[-_]?)?\d)",
        re.IGNORECASE,
    )
    INSTANCE_RE = re.compile(r"(?:redis|Redis)(?:[-_](?:node[-_]?)?|节点[-_]?)\d+", re.IGNORECASE)
    MIDDLEWARE_RE = re.compile(r"Nacos|Consul|Etcd|ElasticSearch|Elasticsearch|ES|Zookeeper|ZooKeeper", re.IGNORECASE)

    def extract(self, text: str) -> ExtractedGraph:
        self.nodes: dict[str, ExtractedNode] = {}
        self.edges: dict[tuple[str, str, str], ExtractedCall] = {}
        self.text = text
        self.sentences = [s.strip() for s in re.split(r"[。；;\n]+", text) if s.strip()]

        self._extract_systems_and_layers()
        self._extract_common_nodes()
        self._extract_contains_relations()
        self._extract_service_db_relations()
        self._extract_dependency_relations()
        self._extract_call_relations()
        self._extract_queue_relations()
        self._extract_function_relations()
        self._extract_metadata()

        if not self.nodes:
            title = self._guess_document_title(text)
            self._add_node(title, "系统层", "System", "从输入文档生成的系统节点")

        return ExtractedGraph(services=list(self.nodes.values()), calls=list(self.edges.values()))

    def _guess_document_title(self, text: str) -> str:
        m = re.search(r"([\u4e00-\u9fa5A-Za-z0-9_\-]{2,40}系统)", text)
        return m.group(1) if m else "系统"

    def _add_node(
        self,
        name: str,
        layer: str,
        kind: str,
        description: str = "",
        meta: dict[str, Any] | None = None,
    ) -> None:
        name = self._clean_name(name)
        if not name:
            return
        kind = kind if kind in ALLOWED_KINDS else "Component"
        layer = layer or self._default_layer(kind)
        old = self.nodes.get(name)
        if old:
            self.nodes[name] = ExtractedNode(
                name=name,
                layer=old.layer if old.layer != "Component层" else layer,
                kind=old.kind if old.kind != "Component" else kind,
                description=old.description or description,
                meta={**(meta or {}), **old.meta},
            )
        else:
            self.nodes[name] = ExtractedNode(
                name=name,
                layer=layer,
                kind=kind,
                description=description or "",
                meta=meta or {},
            )

    def _add_edge(self, source: str, target: str, rel_type: str, description: str = "") -> None:
        source = self._clean_name(source)
        target = self._clean_name(target)
        if not source or not target or source == target:
            return
        if source not in self.nodes:
            self._add_node(source, "Component层", self._infer_kind(source))
        if target not in self.nodes:
            self._add_node(target, "Component层", self._infer_kind(target))
        rel_type = rel_type if rel_type in ALLOWED_RELATIONS else "CALLS"
        self.edges[(source, target, rel_type)] = ExtractedCall(
            source=source, target=target, type=rel_type, description=description or ""
        )

    def _extract_systems_and_layers(self) -> None:
        system = self._guess_document_title(self.text)
        self._add_node(system, "系统层", "System", "系统根节点")

        layer_names: set[str] = set()
        # Prefer explicit composition clauses: 系统由A层、B层组成
        for m in re.finditer(r"由(.{1,100}?)(?:组成|构成)", self.text):
            for item in self._split_items(m.group(1)):
                if item.endswith("层"):
                    layer_names.add(item)
        # Then collect common layer names without swallowing surrounding words.
        common_layer_re = re.compile(r"网关层|接入层|应用层|业务服务层|服务层|数据层|消息层|中间件层|功能层|存储层|展示层|前端层|后端层")
        layer_names.update(common_layer_re.findall(self.text))

        for layer in sorted(layer_names, key=len):
            self._add_node(layer, layer, "Layer", "系统层级")
            self._add_edge(system, layer, "CONTAINS", "系统包含该层级")

    def _extract_common_nodes(self) -> None:
        for raw in sorted(set(self.SERVICE_RE.findall(self.text)), key=len):
            name = self._normalize_entity(raw, "Service")
            if name and f"{name}层" not in self.text:
                self._add_node(name, "业务服务层", "Service")
        for raw in sorted(set(self.DB_RE.findall(self.text)), key=len):
            name = self._normalize_entity(raw, "Database")
            if name:
                self._add_node(name, "数据层", "Database")
        for raw in sorted(set(self.QUEUE_RE.findall(self.text)), key=len):
            name = self._normalize_entity(raw, "Queue")
            if name:
                self._add_node(name, "中间件层", "Queue")
        for raw in sorted(set(self.CACHE_RE.findall(self.text)), key=len):
            name = self._normalize_entity(raw, "Cache")
            if name:
                self._add_node(name, "数据层", self._infer_kind(name))
        for raw in sorted(set(self.INSTANCE_RE.findall(self.text)), key=len):
            name = self._normalize_entity(raw, "Instance")
            if name:
                self._add_node(name, "基础设施层", "Instance")
        for raw in sorted(set(self.MIDDLEWARE_RE.findall(self.text)), key=len):
            name = self._normalize_entity(raw, "Middleware")
            if name:
                self._add_node(name, "中间件层", "Middleware")
        for raw in sorted(set(self.API_RE.findall(self.text)), key=len):
            name = self._normalize_entity(raw, "API")
            if not name or name.lower() == "api":
                continue
            kind = "API" if "api" in name.lower() or "网关" in name else "Component"
            self._add_node(name, "网关层", kind)

    def _extract_contains_relations(self) -> None:
        for sentence in self.sentences:
            m = re.search(r"(.{1,30}?(?:系统|层|服务|集群|缓存|数据库|中间件))\s*(?:包含|包括|由)\s*(.+?)(?:组成|构成)?$", sentence)
            if not m:
                continue
            parent = self._clean_name(m.group(1))
            items = self._split_items(m.group(2))
            self._add_node(parent, self._default_layer(self._infer_kind(parent)), self._infer_kind(parent))
            for item in items:
                item = self._clean_name(item)
                if not item or item in {"和", "以及"}:
                    continue
                self._add_node(item, self._default_layer(self._infer_kind(item)), self._infer_kind(item))
                relation = "HAS_MEMBER" if self._infer_kind(parent) == "Cluster" and self._infer_kind(item) in {"Instance", "Host", "Pod"} else "CONTAINS"
                self._add_edge(parent, item, relation, f"{parent} 包含 {item}")

    def _extract_service_db_relations(self) -> None:
        for sentence in self.sentences:
            sources = [self._normalize_entity(x, "Service") for x in self.SERVICE_RE.findall(sentence)]
            dbs = [self._normalize_entity(x, "Database") for x in self.DB_RE.findall(sentence)]
            sources = [x for x in sources if x]
            dbs = [x for x in dbs if x]
            if not sources or not dbs:
                continue
            relation = "USES_DB"
            if "读取" in sentence or "查询" in sentence:
                relation = "READS"
            if "写入" in sentence or "保存" in sentence:
                relation = "WRITES"
            if "读写" in sentence:
                relation = "USES_DB"
            for source in sources[:1]:
                for db in dbs:
                    self._add_edge(source, db, relation, sentence)

    def _extract_dependency_relations(self) -> None:
        verbs = r"依赖|连接|访问|使用|查询|读写|读取|写入|缓存到|存储到"
        for sentence in self.sentences:
            if not re.search(verbs, sentence):
                continue
            sources = [self._normalize_entity(x, "Service") for x in self.SERVICE_RE.findall(sentence)]
            sources = [item for item in sources if item]
            if not sources:
                continue
            targets: list[str] = []
            for regex, kind in [
                (self.CACHE_RE, "Cache"),
                (self.QUEUE_RE, "Queue"),
                (self.MIDDLEWARE_RE, "Middleware"),
            ]:
                targets.extend(self._normalize_entity(item, kind) for item in regex.findall(sentence))
            targets = [item for item in targets if item and item not in sources]
            relation = "DEPENDS_ON"
            if "读取" in sentence or "查询" in sentence:
                relation = "READS"
            elif "写入" in sentence or "存储" in sentence:
                relation = "WRITES"
            for target in dict.fromkeys(targets):
                self._add_node(target, self._default_layer(self._infer_kind(target)), self._infer_kind(target))
                self._add_edge(sources[0], target, relation, sentence)

    def _extract_call_relations(self) -> None:
        verbs = r"调用|请求|访问|依赖|对接|连接|校验"
        for sentence in self.sentences:
            services = [self._normalize_entity(x, "Service") for x in self.SERVICE_RE.findall(sentence)]
            services = [x for x in services if x]
            if len(services) >= 2 and re.search(verbs, sentence):
                source = services[0]
                for target in services[1:]:
                    self._add_edge(source, target, "CALLS", sentence)
            m = re.search(rf"({self.SERVICE_RE.pattern}).*?(?:{verbs})([^。；;\n]+)", sentence)
            if m:
                source = self._normalize_entity(m.group(1), "Service")
                tail = m.group(2)
                targets = [self._normalize_entity(x, "Service") for x in self.SERVICE_RE.findall(tail)]
                ext = [self._normalize_entity(x, "Component") for x in re.findall(r"[\u4e00-\u9fa5A-Za-z0-9_\-]+平台", tail)]
                for target in [*targets, *ext]:
                    if source and target:
                        self._add_edge(source, target, "CALLS", sentence)

    def _extract_queue_relations(self) -> None:
        known_queues = self.QUEUE_RE.findall(self.text)
        default_queue = known_queues[0] if known_queues else "消息队列"
        for sentence in self.sentences:
            sources = [self._normalize_entity(x, "Service") for x in self.SERVICE_RE.findall(sentence)]
            sources = [x for x in sources if x]
            queues = [self._normalize_entity(x, "Queue") for x in self.QUEUE_RE.findall(sentence)] or ([default_queue] if ("发布" in sentence or "订阅" in sentence) else [])
            if not sources or not queues:
                continue
            queue = queues[0]
            if "发布" in sentence or "发送" in sentence or "生产" in sentence:
                self._add_edge(sources[0], queue, "PUBLISHES", sentence)
            if "订阅" in sentence or "消费" in sentence:
                self._add_edge(sources[0], queue, "SUBSCRIBES", sentence)

    def _extract_function_relations(self) -> None:
        for sentence in self.sentences:
            m = re.search(r"([^，。；;\n]+服务).*?(?:提供|负责)(.+?)(?:功能|能力|服务)?$", sentence)
            if not m:
                continue
            service = self._clean_name(m.group(1))
            function_text = re.split(r"，?(?:读写|读取|写入|会调用|并调用|调用|通过|订阅|发布|依赖).*$", m.group(2))[0]
            functions = []
            for item in self._split_items(function_text):
                item = self._clean_name(re.sub(r"功能$", "", item))
                if 2 <= len(item) <= 30 and not item.endswith("服务") and not item.endswith("数据库"):
                    functions.append(item + "功能" if not item.endswith("功能") else item)
            for fn in functions[:8]:
                self._add_node(fn, "功能层", "Function")
                self._add_edge(service, fn, "PROVIDES", sentence)

    def _extract_metadata(self) -> None:
        # Deterministic fallback for the identifiers most useful to log/KG
        # entity resolution.  It only copies values explicitly present in the
        # document and never invents addresses or aliases.
        alias_pattern = re.compile(
            r"(?P<name>[\u4e00-\u9fa5A-Za-z0-9_-]+服务)[^。；;\n]{0,60}?"
            r"(?:日志服务名|serviceName|别名|alias)(?:（serviceName）)?\s*(?:为|是|[=:：])?\s*`?"
            r"(?P<alias>[A-Za-z][A-Za-z0-9_.-]+)",
            re.IGNORECASE,
        )
        for match in alias_pattern.finditer(self.text):
            name = self._normalize_entity(match.group("name"), "Service")
            if name in self.nodes:
                self._merge_meta(name, {"aliases": [match.group("alias")]})

        for name in list(self.nodes):
            if self.nodes[name].kind not in {"Instance", "Host", "Pod", "Cluster", "Cache", "Database"}:
                continue
            meta: dict[str, Any] = {}
            for segment_match in re.finditer(
                re.escape(name) + r"(?![A-Za-z0-9_-])(?P<meta>[^。；;\n]{0,160})",
                self.text,
                re.IGNORECASE,
            ):
                segment = segment_match.group("meta")
                for key, pattern in {
                    "host": r"(?i)\bhost(?:name)?\s*[=:：]\s*([A-Za-z0-9_.-]+)",
                    "ip": r"(?i)\bip\s*[=:：]\s*((?:\d{1,3}\.){3}\d{1,3})",
                    "port": r"(?i)\bport\s*[=:：]\s*(\d{2,5})",
                }.items():
                    found = re.search(pattern, segment)
                    if found:
                        meta[key] = int(found.group(1)) if key == "port" else found.group(1)
            if meta:
                self._merge_meta(name, meta)

    def _merge_meta(self, name: str, meta: dict[str, Any]) -> None:
        old = self.nodes[name]
        merged = dict(old.meta)
        for key, value in meta.items():
            if key == "aliases":
                merged[key] = list(dict.fromkeys([*_list_values(merged.get(key)), *_list_values(value)]))
            else:
                merged[key] = value
        self.nodes[name] = ExtractedNode(
            name=old.name,
            layer=old.layer,
            kind=old.kind,
            description=old.description,
            source_file=old.source_file,
            meta=merged,
        )

    def _split_items(self, text: str) -> list[str]:
        text = re.sub(r"等(?:信息|组件|服务|功能)?", "", text)
        text = text.replace("以及", "、").replace("和", "、").replace("并", "、")
        parts = re.split(r"[、,，/]+", text)
        cleaned: list[str] = []
        for part in parts:
            part = self._clean_name(part)
            part = re.sub(r"^(包含|包括|由|负责|提供|统一|会|并会|并调用|调用)", "", part)
            if part:
                cleaned.append(part)
        return cleaned

    def _normalize_entity(self, value: str, kind: str) -> str:
        value = self._clean_name(value)
        # Remove common verbal/context prefixes introduced by broad regexes, e.g.
        # "业务服务层包含用户服务" -> "用户服务", "读写用户数据库" -> "用户数据库".
        for sep in ["包含", "包括", "调用", "请求", "访问", "依赖", "读写", "读取", "写入", "使用", "通过", "订阅", "发布", "会", "并"]:
            if sep in value:
                value = value.split(sep)[-1]
        value = value.replace("和", "、")
        if "、" in value:
            parts = [p for p in value.split("、") if p]
            value = parts[-1] if parts else value
        suffix = {
            "Service": "服务",
            "Database": "数据库",
            "Layer": "层",
            "Function": "功能",
        }.get(kind)
        if suffix and suffix in value and not value.endswith(suffix):
            # Keep the last token ending with the desired suffix.
            m = re.findall(rf"[\u4e00-\u9fa5A-Za-z0-9_\-]+{suffix}", value)
            if m:
                value = m[-1]
        return self._clean_name(value)

    def _clean_name(self, value: str) -> str:
        value = str(value or "").strip()
        value = re.sub(r"^(?:[-*+>#]+\s*)+", "", value)
        value = re.sub(r"^[的和及与并、,，\s]+", "", value)
        value = re.sub(r"[的和及与并、,，\s]+$", "", value)
        value = re.sub(r"^(包含|包括|由|负责|提供)", "", value)
        value = re.sub(r"(?:组成|构成)$", "", value)
        value = re.sub(r"\s*[一二三四五六七八九十\d]+个实例$", "", value)
        return value.strip(" ：:。；;\t\r\n")[:80]

    def _infer_kind(self, name: str) -> str:
        lowered = name.lower()
        if name.endswith("系统"):
            return "System"
        if name.endswith("层"):
            return "Layer"
        if name.endswith("服务"):
            return "Service"
        if name.endswith("数据库") or name.lower().endswith("db"):
            return "Database"
        if "redis" in lowered and ("集群" in name or "cluster" in lowered):
            return "Cluster"
        if self.INSTANCE_RE.fullmatch(name):
            return "Instance"
        if "redis" in lowered or "memcached" in lowered:
            return "Cache"
        if name.endswith("集群") or lowered.endswith("cluster"):
            return "Cluster"
        if name.endswith("节点") or name.endswith("实例"):
            return "Instance"
        if re.search(self.QUEUE_RE, name):
            return "Queue"
        if re.search(self.MIDDLEWARE_RE, name):
            return "Middleware"
        if "API" in name.upper() or "网关" in name:
            return "API"
        if name.endswith("功能"):
            return "Function"
        return "Component"

    def _default_layer(self, kind: str) -> str:
        return {
            "System": "系统层",
            "Layer": "系统层",
            "Service": "业务服务层",
            "Database": "数据层",
            "Cache": "数据层",
            "Cluster": "基础设施层",
            "Instance": "基础设施层",
            "Host": "基础设施层",
            "Pod": "基础设施层",
            "Queue": "中间件层",
            "Middleware": "中间件层",
            "API": "网关层",
            "Function": "功能层",
        }.get(kind, "Component层")


def normalize_openai_base_url(url: str) -> str:
    url = url.rstrip("/")
    return url if url.endswith("/v1") else f"{url}/v1"


def split_text(text: str, max_chars: int) -> list[str]:
    text = text.strip()
    if not text:
        return []
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for paragraph in paragraphs or [text]:
        if len(paragraph) > max_chars:
            sentences = [s for s in re.split(r"(?<=[。；;\n])", paragraph) if s.strip()]
        else:
            sentences = [paragraph]
        for sentence in sentences:
            sentence_len = len(sentence) + 1
            if current and current_len + sentence_len > max_chars:
                chunks.append("\n".join(current).strip())
                current = []
                current_len = 0
            current.append(sentence)
            current_len += sentence_len
    if current:
        chunks.append("\n".join(current).strip())
    return [c for c in chunks if c]
