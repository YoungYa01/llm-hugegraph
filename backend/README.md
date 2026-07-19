# Backend

```bash
cd backend
rm -f .env
cp .env.example .env
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

检查：

- http://127.0.0.1:8000/api/health
- http://127.0.0.1:8000/api/debug/hugegraph
- http://127.0.0.1:8000/api/debug/llm
- http://127.0.0.1:8000/api/graph?limit=800

## 主要能力

- `/api/import`：系统架构文档 → 本地 LLM/规则抽取 → HugeGraph。
- `/api/incidents/import`：导入 v1-goat 输出的 `incident_details.json` / zip / csv，把异常链路接入架构图谱。
- `/api/logs/analyze`：可选调用 v1-goat `logfault.pipeline.run_pipeline()`，完成滑动窗口分析后自动导入异常链路。
- `/api/nodes`、`/api/edges`：支持前端交互式新增、修改、删除节点和关系。

## 连接说明

本版继续使用原来的本地大模型连接方式：OpenAI-compatible `/v1/chat/completions` 优先，失败后尝试 llama.cpp `/completion`，再走规则兜底。

HugeGraph 仍使用 REST API，不使用 `/gremlin`。默认 schema label 已升级到：

```env
HUGEGRAPH_NODE_LABEL=LogSysKGNodeV6
HUGEGRAPH_EDGE_LABEL=LOGSYS_KG_RELATION_V6
```

V6 增加了 `meta` 字段，用来保存 traceId、timestamp、source_line、root_cause 等异常链路上下文。
