# 日志智能分析系统

## 推荐使用流程

### 1. 启动后端

```bash
cd backend
cp .env.example .env
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 --log-level info
```

### 2. 启动系统前端

```bash
cd front
npm install # or pnpm install
npm run dev # or pnpm dev
```

打开：

```text
http://127.0.0.1:5173
```

第一次打开请注册账户。首个账户自动成为管理员；之后创建项目，并在项目内按“架构图谱 → 日志数据 → 故障与根因”的顺序操作。

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
  "meta": {
    "aliases": [
      "redis-node-b"
    ],
    "host": "redis-2",
    "ip": "10.0.2.12",
    "port": 6379
  }
}
```

若架构文本没有这些事实，大模型不能凭空补齐；请在前端人工校正后再导入日志。

### 4. 再日志解析检测

点击 **日志解析检测**，上传日志文件or压缩包：

### 5. 查看故障根因定位

点击 **故障根因定位**， 查看故障根因
点击 **综合分析报告**， 查看综合分析报告