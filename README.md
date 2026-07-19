# LogSys KG：架构知识图谱 + 异常链路融合版

这个版本在原有“上传系统架构说明文档 → LLM 抽取 → 写入 HugeGraph → 前端画布展示”的基础上，补齐了面向根因定位的闭环：

1. **架构图谱**：系统、层级、服务、数据库、中间件、队列、API、功能节点。
2. **异常图谱**：Incident、Trace、LogEvent、Exception、Window 等异常分析节点。
3. **融合关系**：`ROOT_SERVICE`、`ROOT_CAUSE`、`HAS_TRACE`、`HAS_EVENT`、`EMITS`、`PROPAGATES_TO`、`ERROR_PROPAGATES_TO` 等关系会把滑动窗口算法输出的异常链路挂到架构服务节点上。
4. **可编辑图谱**：前端可新增、编辑、删除节点和关系；后端提供 REST CRUD 接口。
5. **层次展示**：Canvas 按节点类型层级布局，左侧图例可按节点类型筛选，异常链路与架构层次同图展示。

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

### 2. 启动原生前端

```bash
cd frontend-vanilla
python -m http.server 5174
```

打开：

```text
http://127.0.0.1:5174
```

### 3. 先导入架构

点击 **上传架构**，上传 `.txt/.md/.yaml/.yml` 的系统说明文档。LLM 会抽取架构知识图谱，失败时会切换规则兜底抽取，避免流程中断。

### 4. 再导入异常链路

点击 **导入异常链路**，上传 v1-goat 滑动窗口算法生成的：

- `incident_details.json`
- 或包含 `incident_details.json` / `incidents.csv` / `events.csv` 的 zip
- 或单个 `events.csv` / `incidents.csv`

导入后会自动创建故障、trace、异常日志、异常类节点，并尽量把 `root_service_candidate` / timeline 里的 service 名称匹配到已有架构服务节点。

### 5. 可选：直接运行滑动窗口算法

如果本机已经有 v1-goat 仓库，可以在 `backend/.env` 中配置：

```env
LOGFAULT_PROJECT_PATH=/path/to/spring-log-system
LOGFAULT_CONFIG_PATH=/path/to/spring-log-system/config/default.yaml
LOGFAULT_OUTPUT_ROOT=./runs/kg
```

然后前端点击 **分析日志** 上传日志目录 zip 或 `.log` 文件。后端会尝试调用 `logfault.pipeline.run_pipeline()`，再自动把输出结果导入知识图谱。

> 如果没有配置 `LOGFAULT_PROJECT_PATH`，请先用 v1-goat 项目离线生成结果，再通过“导入异常链路”接入。

## 新增 API

- `POST /api/incidents/import`：导入 `incident_details.json` / zip / csv，并写入异常链路图谱。
- `POST /api/logs/analyze`：可选，调用 v1-goat `logfault.pipeline.run_pipeline()` 分析日志并导入结果。
- `POST /api/nodes`：新增或更新节点。
- `PUT /api/nodes/{name}`：编辑节点属性。
- `DELETE /api/nodes/{name}`：删除节点。
- `POST /api/edges`：新增关系。
- `POST /api/edges/delete`：按 source/target/type 删除关系。

## 图谱融合思路

滑动窗口算法先定位异常窗口和日志链路，知识图谱再回答“这个异常链路落在系统架构中的哪里”。融合逻辑如下：

```text
Incident
  ├─ROOT_SERVICE──> Service / API / Component
  ├─ROOT_CAUSE────> Exception
  ├─HAS_TRACE─────> Trace
  └─HAS_EVENT─────> LogEvent

Service ──EMITS────────────> LogEvent
LogEvent ──PROPAGATES_TO───> LogEvent
Service ──ERROR_PROPAGATES_TO──> Service
```

这样用户可以从故障节点进入 trace 和日志证据，也可以从架构服务节点反查它产生过哪些异常、影响了哪些上游/下游服务。
