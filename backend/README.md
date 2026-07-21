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

系统接口统一要求 `Authorization: Bearer <token>`：

- `/api/auth/*`：注册、登录、会话恢复和退出。
- `/api/projects/*`：项目管理及项目总览。
- `/api/projects/{project_id}/architectures/*`：项目架构版本和 LLM 图谱导入。
- `/api/projects/{project_id}/graph/*`：项目隔离的节点、关系查询与人工维护。
- `/api/projects/{project_id}/logs/*`：日志批次、滑动窗口分析和结果产物。
- `/api/projects/{project_id}/incidents/*`：故障列表、RCA 详情、处理状态及解决审计。

SQLite 默认写入 `backend/data/logsys.db`，上传数据按 `data/projects/<project_id>/...` 隔离；HugeGraph 节点名使用 `project::<project_id>::` 命名空间隔离。

`GET /api/projects/{project_id}/graph` 只返回静态架构投影。当前故障与架构融合图使用 `GET /api/projects/{project_id}/incidents/{incident_id}/graph`；可以用 `include_events=true` 展开日志事件节点。`PUT /graph/edges` 支持关系编辑，`DELETE /logs/{batch_id}` 会级联删除传错的日志批次和关联故障。

下面是不带项目隔离的旧 Demo 接口，仅用于兼容原页面：

- `/api/import`：系统架构文档 → 本地 LLM/规则抽取 → HugeGraph。
- `/api/incidents/import`：导入 v1-goat 输出的 `incident_details.json` / zip / csv，执行实体对齐、依赖反向遍历和 Top-K RCA 后接入架构图谱。
- `/api/logs/analyze`：可选调用 v1-goat `logfault.pipeline.run_pipeline()`，完成滑动窗口分析后自动导入异常链路。
- `/api/incidents/{incident_id}/rca`：读取已持久化的根因候选、启发式评分、证据、缺失证据和因果链。
- `/api/nodes`、`/api/edges`：支持前端交互式新增、修改、删除节点和关系。

`/api/logs/analyze` 的运行目录除原滑动窗口结果外，还会写出 `rca_results.json` 和 `kg_rca_report.md`。

## RCA 所需的最小架构模型

存储方向统一为“调用者/消费者 → 被依赖者”：

```text
api-gateway -CALLS-> security-service
security-service -DEPENDS_ON-> Redis生产集群
Redis生产集群 -HAS_MEMBER-> redis-1
Redis生产集群 -HAS_MEMBER-> redis-2
Redis生产集群 -HAS_MEMBER-> redis-3
```

实例节点建议在 `meta` 中维护 `aliases`、`host`、`ip`、`port` 和 `endpoints`。RCA 会反向输出 `redis-2 -> Redis生产集群 -> security-service -> api-gateway`。若日志只有超时而没有节点标识或健康状态，系统会停在集群级候选并返回缺失证据说明。

时间先后边使用 `TEMPORALLY_PRECEDES`；它只是事实，不被当作因果边。真正的候选链保存在 `RCAHypothesis.meta.chain/path_steps` 中。

## 连接说明

本版继续使用原来的本地大模型连接方式：OpenAI-compatible `/v1/chat/completions` 优先，失败后尝试 llama.cpp `/completion`，再走规则兜底。

HugeGraph 仍使用 REST API，不使用 `/gremlin`。默认 schema label 已升级到：

```env
HUGEGRAPH_NODE_LABEL=LogSysKGNodeV7
HUGEGRAPH_EDGE_LABEL=LOGSYS_KG_RELATION_V7
```

V7 延续 `meta` 字段，并隔离旧版把时间相邻误标为因果传播的关系数据。它用于保存 traceId、timestamp、source_line、root_cause、RCA 评分、证据和链路等上下文。

## 测试

```bash
pytest -q
```
