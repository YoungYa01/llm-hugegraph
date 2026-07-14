# LogSys KG Demo：离线依赖说明 + 原生 JS 备用前端

本包包含两个前端：

1. `frontend/`：原 React + vis-network 版本。
2. `frontend-vanilla/`：纯 HTML + 原生 JS + Canvas 版本，无 npm 依赖，适合内网备用。

后端仍然使用已经跑通的 FastAPI + HugeGraph REST 版本。

## 纯原生前端启动

```bash
cd backend
cp .env.example .env
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 --log-level info
```

另开终端：

```bash
cd frontend-vanilla
python -m http.server 5174
```

打开：

```text
http://127.0.0.1:5174
```

## 前端依赖离线整理

见：`OFFLINE_FRONTEND_DEPENDENCIES.md`。

最推荐的内网方式是：在有网机器上 `pnpm build`，只把 `frontend/dist` 拷进内网。内网不再安装 node_modules，也不会碰到 rolldown 缺失。
