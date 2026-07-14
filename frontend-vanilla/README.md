# LogSys 纯 HTML + 原生 JS 前端

这个目录是不依赖 npm / pnpm / node_modules 的备用前端，只有：

- `index.html`
- `style.css`
- `app.js`

它直接调用后端：`http://127.0.0.1:8000/api/graph`、`/api/import`、`/api/clear`。

## 启动方式

先启动后端：

```bash
cd backend
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 --log-level info
```

再启动静态前端：

```bash
cd frontend-vanilla
python -m http.server 5174
```

浏览器打开：

```text
http://127.0.0.1:5174
```

## 修改后端地址

默认 API 地址是：

```text
http://127.0.0.1:8000
```

如果需要改地址，可以在浏览器控制台执行：

```js
localStorage.setItem('LOGSYS_API_BASE', 'http://你的后端IP:8000')
location.reload()
```

恢复默认：

```js
localStorage.removeItem('LOGSYS_API_BASE')
location.reload()
```
