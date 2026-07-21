# LogScope RCA：项目级架构知识图谱与日志根因定位系统

这已经不再只是单页 Demo：当前版本加入了用户登录、项目空间、项目级图谱隔离、架构版本、日志批次、故障列表、RCA 详情、状态流转和解决记录。系统设计见 [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md)，RCA 算法细节见 [`docs/PROJECT_IMPLEMENTATION.md`](docs/PROJECT_IMPLEMENTATION.md)。

这个版本在原有“上传系统架构说明文档 → LLM 抽取 → 写入 HugeGraph → 前端画布展示”的基础上，补齐了面向根因定位的闭环：

1. **架构图谱**：系统、层级、服务、数据库、中间件、队列、API、功能节点。
2. **异常图谱**：Incident、Trace、LogEvent、Exception、Window 等异常分析节点。
3. **实体对齐**：用节点名和 `meta.aliases/host/ip/port/endpoints` 把日志中的 service、host、IP、端口对齐到架构实体。
4. **根因推理**：按依赖边反向遍历，输出 Top-K `RCAHypothesis`，每个候选都包含评分、证据、缺失证据和因果链。
5. **证据边界**：时间相邻日志只写为 `TEMPORALLY_PRECEDES`，不会再被伪装成因果关系；超时但没有节点级证据时只定位到 Redis 集群，不会武断声称某个实例宕机。
6. **可编辑图谱**：前端可新增、编辑、删除节点和关系；后端提供 REST CRUD 接口。
7. **项目闭环**：SQLite 管理账户、项目、批次、故障和审计记录；HugeGraph 保存每个项目隔离后的架构与异常图谱。
8. **模块化原生前端**：`frontend-system` 使用原生 HTML/CSS/ES Modules，页面、API、路由和 SVG 图谱组件拆分为多个文件，不需要 npm 构建。
9. **视图严格分离**：架构页面只显示静态系统节点和依赖边；Incident、Trace、LogEvent、Exception、RCAHypothesis 只出现在对应故障的融合定位子图。
10. **完整维护能力**：节点和关系均可新增、编辑、删除；日志传错后可删除整个批次，并级联清理故障记录、分析产物和批次动态图节点。

## 推荐使用流程

### 1. 启动后端

```bash
cd backend
cp .env.example .env
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 --log-level info
```

检查：

- http://127.0.0.1:8000/api/health
- http://127.0.0.1:8000/api/debug/hugegraph
- http://127.0.0.1:8000/api/debug/llm
- http://127.0.0.1:8000/api/graph?limit=800

### 2. 启动系统前端

```bash
./scripts/start-frontend.sh
```

Windows 使用 `scripts\start-frontend.bat`。启动器会禁用浏览器缓存；正确页面的登录页和侧边栏显示版本 `2026.07.21-r2`。

打开：

```text
http://127.0.0.1:5174
```

第一次打开请注册账户。首个账户自动成为管理员；之后创建项目，并在项目内按“架构图谱 → 日志数据 → 故障与根因”的顺序操作。

`frontend-vanilla` 是停用的旧接口开发页，其 Windows 启动器只做兼容转发。项目管理、节点/关系编辑删除和日志批次删除均在 `frontend-system` 中。

### 3. 先导入架构

点击 **上传架构**，上传 `.txt/.md/.yaml/.yml` 的系统说明文档。LLM 会抽取架构知识图谱，失败时会切换规则兜底抽取，避免流程中断。

要做实例级根因定位，架构文档至少要明确下面三类关系：

```text
api-gateway -CALLS-> security-service
security-service -DEPENDS_ON-> Redis生产集群
Redis生产集群 -HAS_MEMBER-> redis-1 / redis-2 / redis-3
```

节点级标识放在 `meta`，供日志实体对齐使用：

```json
{
  "name": "redis-2",
  "kind": "Instance",
  "meta": {"aliases": ["redis-node-b"], "host": "redis-2", "ip": "10.0.2.12", "port": 6379}
}
```

若架构文本没有这些事实，大模型不能凭空补齐；请在前端人工校正后再导入日志。

### 4. 再导入异常链路

点击 **导入异常链路**，上传 v1-goat 滑动窗口算法生成的：

- `incident_details.json`
- 或包含 `incident_details.json` / `incidents.csv` / `events.csv` 的 zip
- 或单个 `events.csv` / `incidents.csv`

导入后会自动创建故障、trace、异常日志、异常类和 `RCAHypothesis` 节点，并尽量把 `root_service_candidate` / timeline 里的 service、host、IP、port 匹配到已有架构节点。接口响应的 `rca[].hypotheses` 会直接返回排序结果。

### 5. 可选：直接运行滑动窗口算法

如果本机已经有 v1-goat 仓库，可以在 `backend/.env` 中配置：

```env
LOGFAULT_PROJECT_PATH=/path/to/spring-log-system
LOGFAULT_CONFIG_PATH=/path/to/spring-log-system/config/default.yaml
LOGFAULT_OUTPUT_ROOT=./runs/kg
```

然后前端点击 **分析日志** 上传日志目录 zip 或 `.log` 文件。后端会尝试调用 `logfault.pipeline.run_pipeline()`，再自动把输出结果导入知识图谱。

同一个输出目录会新增：

- `rca_results.json`：完整机器可读 Top-K 假设。
- `kg_rca_report.md`：根因、评分、因果链和缺失证据的可读报告。

> 如果没有配置 `LOGFAULT_PROJECT_PATH`，请先用 v1-goat 项目离线生成结果，再通过“导入异常链路”接入。

## 新增 API

- `POST /api/incidents/import`：导入 `incident_details.json` / zip / csv，并写入异常链路图谱。
- `POST /api/logs/analyze`：可选，调用 v1-goat `logfault.pipeline.run_pipeline()` 分析日志并导入结果。
- `GET /api/incidents/{incident_id}/rca`：读取已经持久化的 Top-K 根因假设、评分、证据和链路。
- `POST /api/nodes`：新增或更新节点。
- `PUT /api/nodes/{name}`：编辑节点属性。
- `DELETE /api/nodes/{name}`：删除节点。
- `POST /api/edges`：新增关系。
- `POST /api/edges/delete`：按 source/target/type 删除关系。

## 图谱融合思路

滑动窗口算法负责找到异常窗口并抽取结构化证据；RCA 引擎负责实体对齐、候选生成、依赖反向遍历和排序。融合逻辑如下：

```text
Incident
  ├─OBSERVED_AT────> Service / API / Component
  ├─HAS_EXCEPTION──> Exception
  ├─HAS_TRACE─────> Trace
  ├─HAS_EVENT─────> LogEvent
  ├─HAS_HYPOTHESIS─> RCAHypothesis
  └─SUSPECTED_ROOT_CAUSE─> ArchitectureNode

Service ──EMITS────────────> LogEvent
LogEvent ──TEMPORALLY_PRECEDES──> LogEvent
RCAHypothesis ──CANDIDATE_CAUSE──> Cluster / Instance / Database / Service
RCAHypothesis ──SUPPORTED_BY──────> RootCandidate
RCAHypothesis ──AFFECTS───────────> Service / API
```

`CALLS`、`DEPENDS_ON`、`USES_DB` 等边的存储方向是“调用者/消费者 → 被依赖者”。故障传播方向相反。例如：

```text
存储拓扑：api-gateway -> security-service -> Redis生产集群 -> redis-2
根因链路：redis-2 -> Redis生产集群 -> security-service -> api-gateway
```

## Redis 超时应该如何解释

- 只有 `RedisCommandTimeoutException`：可以给出“Redis 集群/依赖路径超时”，不能确认某台机器崩溃。
- 日志同时包含 `redis-2:6379 connection refused`，且图谱中 `redis-2.meta.host/port` 可匹配：实例候选会升到 Top-1。
- 若再接入 Redis `PING`、Sentinel/Cluster 状态、容器重启事件或主机指标，可把“疑似实例故障”提升为强证据结论。
- 所有 `confidence` 都是可解释启发式评分，不是统计概率；生产结论应保留人工确认状态。

本地 Qwen 模型用于架构/日志字段抽取和最终文字解释；候选搜索、路径计算和评分由确定性代码完成，避免量化小模型凭空编造拓扑。

## 测试

```bash
cd backend
pytest -q
```

测试覆盖“仅超时定位到集群”“host+port 证据定位到具体 Redis 成员”“持久化排序”和“异常导入不覆盖人工维护的架构节点”。
