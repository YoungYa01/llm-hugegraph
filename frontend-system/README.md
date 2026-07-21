# LogScope RCA 原生管理前端

前端不需要 Node.js、npm 或打包器。所有代码由原生 HTML、CSS 和 JavaScript ES Modules 组成。

## 启动

Linux / macOS：

```bash
../scripts/start-frontend.sh
```

Windows CMD / PowerShell：

```text
..\scripts\start-frontend.bat
..\scripts\start-frontend.ps1
```

启动脚本使用 `serve.py` 禁用静态资源缓存，避免浏览器继续运行旧 JavaScript。打开 `http://127.0.0.1:5174` 后，登录页与侧边栏应显示版本 `2026.07.21-r2`。默认访问 `http://127.0.0.1:8000/api`；如后端地址不同，可在浏览器控制台设置：

```js
localStorage.setItem("logscope_api_base", "http://你的后端地址:8000/api")
location.reload()
```

## 目录

- `js/api.js`：Bearer Token 和所有后端请求。
- `js/router.js`：Hash 路由。
- `js/shell.js`：项目侧边栏与顶栏。
- `js/graph-view.js`：原生 SVG 拓扑图、缩放和节点选择。
- `js/pages/`：登录、项目、总览、架构、日志、故障和详情页面。
- `styles/`：基础变量、布局和组件样式。

架构页面只请求纯架构投影，并提供显式的节点/关系管理表。点击图中节点或加宽的关系热区后，画布左上角和右侧检查器都会出现编辑、删除按钮。日志页面的批次表提供删除操作。故障详情页单独请求当前 Incident 的融合子图，可以按需展开日志事件节点；长传播链和长日志时间线默认折叠。

登录 Token 在当前 MVP 中保存到 `localStorage`。生产环境建议改为同域部署、HTTPS 和 HttpOnly/SameSite Cookie，并补充 CSP。
