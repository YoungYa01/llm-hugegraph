# LogScope RCA — Semi Design + React Router 重构版

本版本已按标准 React 前端工程方式重构，不再保留 `src/js` / `src/react` 双目录，也不再使用原生 Hash Router。

## 技术栈

- React 18
- Vite
- Semi Design：`@douyinfe/semi-ui` / `@douyinfe/semi-icons`
- React Router：`react-router-dom`
- D3：仅负责架构拓扑、故障融合图和报告图表的绘制

## 运行

```bash
npm install
npm run dev
```

构建：

```bash
npm run build
npm run preview
```

默认后端 API 仍为 `http://127.0.0.1:8000/api`，可通过 `localStorage.logscope_api_base` 覆盖。

## src 工程结构

```text
src/
├── App.jsx
├── main.jsx
├── pages/                  # 页面级 React Components
│   ├── AuthPage.jsx
│   ├── ProjectsPage.jsx
│   ├── GraphAdminPage.jsx
│   ├── ProjectPage.jsx
│   ├── OverviewPage.jsx
│   ├── ArchitecturePage.jsx
│   ├── LogsPage.jsx
│   ├── IncidentsPage.jsx
│   ├── IncidentDetailPage.jsx
│   ├── ReportsPage.jsx
│   └── LogReportPage.jsx
├── components/             # 公共 UI / Layout / 业务组件
│   ├── AppShell.jsx
│   ├── AdminShell.jsx
│   ├── Sidebar.jsx
│   ├── ProjectModal.jsx
│   ├── SemiAdapter.jsx
│   ├── TaskDock.jsx
│   ├── TechTaskCard.jsx
│   ├── Ui.jsx
│   └── Icons.jsx
├── hooks/                  # React hooks
│   └── useActiveTasks.js
├── routes/                 # react-router-dom 路由与路径定义
│   ├── AppRoutes.jsx
│   ├── navigation.js
│   └── paths.js
├── tools/                  # D3 / 图谱 / 后台任务等业务工具
│   ├── graph-view.js
│   ├── graph-semantics.js
│   ├── report-charts.js
│   └── taskManager.js
├── utils/                  # API、鉴权、状态与格式化工具
│   ├── api.js
│   ├── auth.js
│   ├── config.js
│   ├── state.js
│   └── ui.js
└── styles/
    ├── base.css
    ├── components.css
    ├── layout.css
    └── semi-overrides.css
```

## Semi Design 的使用方式

本次不是简单套一层 Semi 默认主题，而是按模块功能采用对应组件，再通过原有 CSS 与 `semi-overrides.css` 保持 LogScope 原界面的视觉语言：

- 登录/注册：`Tabs`、`Input`、`Button`
- 项目空间：`Card`、`Avatar`、`Table`、`Select`、`Modal`、`Tag`
- 日志解析：`Upload`、`Table`、`Button`、`Modal.confirm`
- 故障列表：`Input`、`Select`、`Table`、`Pagination`、`Tag`
- 架构管理：`Upload`、`Table`、`Checkbox`、`Tag`、`Modal.confirm`
- HugeGraph 管理：`Table`、`Pagination`、`Checkbox`、`Tag`、`Modal`
- 综合报告：`Table`、`Tag`
- 全局状态：`Spin`、`Empty`、`Toast`、`Progress`、`Tooltip`

D3 不再负责页面 DOM，只通过 React `ref + useEffect` 绘制拓扑/图表。

## 路由

所有路由统一由 `react-router-dom` 的 `BrowserRouter / Routes / Route / Navigate / Link / NavLink / useNavigate / useParams / useSearchParams` 管理。

当前主要路由：

```text
/login
/projects
/projects/:projectId/overview
/projects/:projectId/architecture
/projects/:projectId/logs
/projects/:projectId/incidents
/projects/:projectId/incidents/:incidentId
/projects/:projectId/reports
/projects/:projectId/reports/:batchId
```

代码中已移除 `window.location.hash`、`hashchange` 和 `#/...` 手工跳转。

## 样式策略

`main.jsx` 先加载 Semi Design 基础 CSS，再加载原项目的 `base.css / components.css / layout.css`，最后加载 `semi-overrides.css`。因此组件交互能力来自 Semi，颜色、边框、间距、圆角、表格密度、上传区、弹窗等视觉尽量保持原界面一致。

## 本轮界面精度优化

- 所有功能性图标统一来自 `@douyinfe/semi-icons`，不再保留自绘 SVG、Emoji 或字符图标。
- Semi `Input / TextArea / Select / AutoComplete` 与原生表单 CSS 完全分离，避免 wrapper 与内部 input 重复 padding；普通表单、筛选栏和紧凑表格控件分别定义高度。
- 架构图节点搜索改为 Semi `AutoComplete`，保持原来的单一复合搜索框布局，并支持按节点名称、类型、架构层匹配和候选展示。
- 节点类型编辑也改为 Semi `AutoComplete`，既能选择常见类型，也允许自定义输入。
- 图谱工具栏、故障拓扑工具栏、返回/编辑/删除/导入/导出/刷新/缩放等操作统一为 Semi Icons。
- 登录 Tabs、项目搜索、用户角色 Select、侧栏退出、空状态、Toast、上传区和表格密度均做了针对性样式覆盖，避免直接套用 Semi 默认视觉。

视觉覆盖规则集中在 `src/styles/semi-overrides.css`，原业务颜色、间距和圆角仍以项目原样式为基准。
