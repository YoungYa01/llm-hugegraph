import {
	IconChevronDown,
	IconDeleteStroked,
	IconDownload,
	IconEditStroked,
	IconFullScreenStroked,
	IconMinus,
	IconPlus,
	IconRefresh,
	IconSearch,
	IconSync,
	IconUpload,
	IconWindowAdaptionStroked,
} from "@douyinfe/semi-icons";
import { AutoComplete, Checkbox, Modal as SemiModal, Table, Tag, Upload } from "@douyinfe/semi-ui";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GraphDeleteProgress } from "../components/GraphDeleteProgress.jsx";
import { JsonEditorField } from "../components/JsonEditorField.jsx";
import { AppButton, AppInput, AppSelect, AppTextArea } from "../components/SemiAdapter.jsx";
import { TechTaskCard } from "../components/TechTaskCard.jsx";
import { EmptyState, ErrorState, LoadingState, Modal } from "../components/Ui.jsx";
import { useActiveTasks } from "../hooks/useActiveTasks.js";
import { renderGraph } from "../tools/graph-view.js";
import { taskManager } from "../tools/taskManager.js";
import { api } from "../utils/api.js";
import { toast } from "../utils/ui.js";

const cache = new Map();
const taskSteps = [
	{ at: 5, label: "准备文件" },
	{ at: 20, label: "LLM 抽取" },
	{ at: 75, label: "HugeGraph 建图" },
	{ at: 95, label: "更新图谱" },
];
const legend = [
	["#c44578", "界面交互"],
	["#3f6fba", "服务"],
	["#178a80", "数据资源"],
	["#117b74", "集群"],
	["#c8722f", "实例"],
];
const nodeKinds = [
	"System",
	"Service",
	"API",
	"Database",
	"Cache",
	"Queue",
	"Middleware",
	"Cluster",
	"Instance",
	"Host",
	"Pod",
	"Component",
];

const edgeTypes = [
	["CALLS", "CALLS · 微服务/接口服务间调用"],
	["DEPENDS_ON", "DEPENDS_ON · 业务服务依赖组件/基础设施"],
	["USES_DB", "USES_DB · 读写使用数据库或缓存"],
	["TRIGGERS", "TRIGGERS · UI页面功能触发API接口"],
	["BELONGS_TO", "BELONGS_TO · 前端控件归属于页面功能"],
	["ROUTES_TO", "ROUTES_TO · API网关路由调度到后端微服务"],
	["RUNS_ON", "RUNS_ON · 容器Pod实例承载运行微服务"],
	["HOSTED_ON", "HOSTED_ON · 容器/数据库托管部署在宿主机"],
	["CONNECTS_TO", "CONNECTS_TO · 物理宿主机连接网络交换机"],
	["READS", "READS · 数据存储只读依赖关系"],
	["WRITES", "WRITES · 数据存储写入依赖关系"],
	["PUBLISHES", "PUBLISHES · 消息队列发布事件"],
	["SUBSCRIBES", "SUBSCRIBES · 消息队列订阅消费事件"],
	["HAS_MEMBER", "HAS_MEMBER · 逻辑集群包含物理具体实例"],
	["CONTAINS", "CONTAINS · 系统分层/模块逻辑包含"],
];

function confirmDanger(content) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		SemiModal.confirm({
			title: "确认删除",
			content,
			okText: "确认删除",
			cancelText: "取消",
			okType: "danger",
			onOk: () => finish(true),
			onCancel: () => finish(false),
		});
	});
}

function GraphLegend() {
	return (
		<div className="graph-legend">
			{legend.map(([color, label]) => (
				<span key={label}>
					<i className="legend-dot" style={{ background: color }} />
					{label}
				</span>
			))}
		</div>
	);
}

function NodeModal({ projectId, node, graph, onClose, onSaved }) {
	const [busy, setBusy] = useState(false);
	const [kind, setKind] = useState(node?.kind || "Service");
	const metadataEditorRef = useRef(null);
	async function submit(event) {
		event.preventDefault();
		const values = Object.fromEntries(new FormData(event.currentTarget));
		if (!String(kind || "").trim()) return toast("请选择或输入节点类型", "error");
		values.kind = String(kind).trim();
		try {
			values.meta = JSON.parse(metadataEditorRef.current?.getValue?.() || "{}");
		} catch {
			return toast("元数据必须是有效 JSON，请检查 JSON 语法", "error");
		}
		setBusy(true);
		try {
			const result = node
				? await api.updateNode(projectId, node.name, values)
				: await api.createNode(projectId, values);
			toast(node ? "节点已更新" : "节点已创建");
			onSaved(result.graph);
			onClose();
		} catch (err) {
			toast(err.message, "error");
			setBusy(false);
		}
	}
	return (
		<Modal title={node ? "编辑架构节点" : "新增架构节点"} onClose={onClose}>
			<form className="form-stack" onSubmit={submit}>
				<div className="field">
					<label>名称</label>
					<AppInput className="input" name="name" required maxLength="180" defaultValue={node?.name || ""} />
				</div>
				<div className="form-row">
					<div className="field">
						<label>类型 kind</label>
						<AutoComplete
							className="input node-kind-autocomplete"
							data={nodeKinds}
							value={kind}
							showClear={false}
							placeholder="选择或输入节点类型"
							onSearch={setKind}
							onChange={(value) => setKind(String(value || ""))}
						/>
						<input type="hidden" name="kind" value={kind} />
					</div>
					<div className="field">
						<label>层级 layer</label>
						<AppInput className="input" name="layer" defaultValue={node?.layer || "业务服务层"} />
					</div>
				</div>
				<div className="field">
					<label>描述</label>
					<AppTextArea className="textarea" name="description" defaultValue={node?.description || ""} />
				</div>
				<div className="field">
					<label>元数据 JSON</label>
					<JsonEditorField
						ref={metadataEditorRef}
						value={JSON.stringify(node?.meta || {}, null, 2)}
						hint="实例级根因需要 host / port / endpoints 等标识才能精确匹配。"
					/>
				</div>
				<div style={{ display: "flex", justifyContent: "flex-end", gap: 9 }}>
					<AppButton type="button" className="button button-secondary" onClick={onClose}>
						取消
					</AppButton>
					<AppButton className="button button-primary" type="submit" disabled={busy}>
						{busy ? "保存中…" : "保存节点"}
					</AppButton>
				</div>
			</form>
		</Modal>
	);
}

function EdgeModal({ projectId, edge, graph, selectedNode, onClose, onSaved }) {
	const defaultSource = edge?.source || selectedNode?.name || graph.nodes[0]?.name || "";
	const defaultTarget =
		edge?.target || graph.nodes.find((n) => n.name !== defaultSource)?.name || graph.nodes[1]?.name || "";
	const [busy, setBusy] = useState(false);
	const metadataEditorRef = useRef(null);
	async function submit(event) {
		event.preventDefault();
		const values = Object.fromEntries(new FormData(event.currentTarget));
		if (values.source === values.target) return toast("源节点与目标节点不能相同", "error");
		try {
			values.meta = JSON.parse(metadataEditorRef.current?.getValue?.() || "{}");
		} catch {
			return toast("元数据必须是有效 JSON，请检查 JSON 语法", "error");
		}
		setBusy(true);
		try {
			const result = edge
				? await api.updateEdge(projectId, {
						original_source: edge.source,
						original_target: edge.target,
						original_type: edge.type,
						...values,
					})
				: await api.createEdge(projectId, values);
			toast(edge ? "关系已更新" : "关系已创建");
			onSaved(result.graph);
			onClose();
		} catch (err) {
			toast(err.message, "error");
			setBusy(false);
		}
	}
	return (
		<Modal title={edge ? "编辑架构关系" : "新增架构关系"} onClose={onClose}>
			<form className="form-stack" onSubmit={submit}>
				<div className="field">
					<label>源节点（调用方/依赖方）</label>
					<AppSelect className="select" name="source" required defaultValue={defaultSource}>
						{graph.nodes.map((n) => (
							<option key={n.name} value={n.name}>
								{n.name} · {n.kind}
							</option>
						))}
					</AppSelect>
				</div>
				<div className="field">
					<label>关系类型</label>
					<AppSelect className="select" name="type" required defaultValue={edge?.type || "DEPENDS_ON"}>
						{edgeTypes.map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</AppSelect>
				</div>
				<div className="field">
					<label>目标节点（被调用方/被依赖方）</label>
					<AppSelect className="select" name="target" required defaultValue={defaultTarget}>
						{graph.nodes.map((n) => (
							<option key={n.name} value={n.name}>
								{n.name} · {n.kind}
							</option>
						))}
					</AppSelect>
				</div>
				<div className="field">
					<label>说明</label>
					<AppInput
						className="input"
						name="description"
						defaultValue={edge?.description || ""}
						placeholder="关系的业务语义或环境信息"
					/>
				</div>
				<div className="field">
					<label>元数据 JSON</label>
					<JsonEditorField
						ref={metadataEditorRef}
						value={JSON.stringify(edge?.meta || {}, null, 2)}
						height={200}
						hint={`依赖边必须按“调用方 → 被依赖方”录入。`}
					/>
				</div>
				<div style={{ display: "flex", justifyContent: "flex-end", gap: 9 }}>
					<AppButton type="button" className="button button-secondary" onClick={onClose}>
						取消
					</AppButton>
					<AppButton className="button button-primary" type="submit" disabled={busy}>
						{busy ? "保存中…" : "保存关系"}
					</AppButton>
				</div>
			</form>
		</Modal>
	);
}

function Inspector({ selectedNode, selectedEdge, graph, onEditNode, onDeleteNode, onEditEdge, onDeleteEdge, deleting }) {
	if (selectedNode) {
		const adjacent = graph.edges.filter((e) => e.source === selectedNode.name || e.target === selectedNode.name);
		return (
			<>
				<span className="badge">架构节点</span>
				<h3 style={{ fontSize: 18, margin: "12px 0 4px" }}>{selectedNode.name}</h3>
				<p style={{ color: "var(--ink-500)" }}>
					{selectedNode.kind} · {selectedNode.layer || "未分层"}
				</p>
				<p>{selectedNode.description || "暂无描述"}</p>
				<dl className="kv-list">
					<div className="kv-row">
						<dt>相邻关系</dt>
						<dd>{adjacent.length}</dd>
					</div>
					<div className="kv-row">
						<dt>元数据</dt>
						<dd>
							<pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
								{JSON.stringify(selectedNode.meta || {}, null, 2)}
							</pre>
						</dd>
					</div>
				</dl>
				<div className="inspector-actions">
					<AppButton disabled={Boolean(deleting)} icon={<IconEditStroked />} className="button button-secondary" type="button" onClick={onEditNode}>
						编辑节点
					</AppButton>
					<AppButton disabled={Boolean(deleting)} loading={deleting?.kind === "node" && deleting?.name === selectedNode.name} icon={<IconDeleteStroked />} className="button button-danger" type="button" onClick={onDeleteNode}>
						删除节点
					</AppButton>
				</div>
			</>
		);
	}
	if (selectedEdge)
		return (
			<>
				<span className="badge">架构关系</span>
				<h3 style={{ fontSize: 17, margin: "12px 0" }}>
					{selectedEdge.source}
					<br />
					<span style={{ color: "var(--brand)" }}>—[{selectedEdge.type}]→</span>
					<br />
					{selectedEdge.target}
				</h3>
				<p>{selectedEdge.description || "暂无关系说明"}</p>
				<dl className="kv-list">
					<div className="kv-row">
						<dt>元数据</dt>
						<dd>
							<pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
								{JSON.stringify(selectedEdge.meta || {}, null, 2)}
							</pre>
						</dd>
					</div>
				</dl>
				<div className="inspector-actions">
					<AppButton disabled={Boolean(deleting)} icon={<IconEditStroked />} className="button button-secondary" type="button" onClick={onEditEdge}>
						编辑关系
					</AppButton>
					<AppButton disabled={Boolean(deleting)} loading={deleting?.kind === "edge"} icon={<IconDeleteStroked />} className="button button-danger" type="button" onClick={onDeleteEdge}>
						删除关系
					</AppButton>
				</div>
			</>
		);
	return <EmptyState compact title="选择图中元素" detail="点击节点或连线后，可在这里查看、编辑或删除。" />;
}

export function ArchitecturePage({ project }) {
	const cached = cache.get(project.id);
	const [graph, setGraph] = useState(cached?.graph || { nodes: [], edges: [], warnings: [] });
	const [loading, setLoading] = useState(!cached);
	const [error, setError] = useState(null);
	const [viewMode, setViewMode] = useState("force");
	const [selectedNode, setSelectedNode] = useState(null);
	const [selectedEdge, setSelectedEdge] = useState(null);
	const [nodeSelection, setNodeSelection] = useState(() => new Set());
	const [edgeSelection, setEdgeSelection] = useState(() => new Set());
	const [modal, setModal] = useState(null);
	const [file, setFile] = useState(null);
	const [architectureFileList, setArchitectureFileList] = useState([]);
	const [importing, setImporting] = useState(false);
	const [syncing, setSyncing] = useState(false);
	const [deleting, setDeleting] = useState(null);
	const [deleteNotice, setDeleteNotice] = useState(null);
	const deleteLock = useRef(false);
	const loadVersion = useRef(0);
	const mounted = useRef(true);
	const [nodeSearch, setNodeSearch] = useState("");
	const canvasRef = useRef(null);
	const shellRef = useRef(null);
	const controllerRef = useRef(null);
	const activeTasks = useActiveTasks();
	const activeTask = activeTasks.find((t) => t.type === "architecture") || null;
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; loadVersion.current += 1; };
	}, []);

	const load = useCallback(
		async ({ quiet = false } = {}) => {
			if (deleteLock.current) return;
			const version = ++loadVersion.current;
			if (!quiet && !cache.has(project.id)) setLoading(true);
			if (!quiet) setSyncing(true);
			try {
				const graphData = await api.graph(project.id);
				if (!mounted.current || version !== loadVersion.current) return;
				cache.set(project.id, { graph: graphData });
				setGraph(graphData);
				setNodeSelection(new Set());
				setEdgeSelection(new Set());
				setSelectedNode(null);
				setSelectedEdge(null);
				setError(null);
				setDeleteNotice(null);
			} catch (err) {
				if (!mounted.current || version !== loadVersion.current) return;
				if (!quiet || !cache.has(project.id)) setError(err);
			} finally {
				if (mounted.current && version === loadVersion.current) {
					setLoading(false);
					setSyncing(false);
				}
			}
		},
		[project.id],
	);
	useEffect(() => {
		load({ quiet: Boolean(cached) });
	}, [load]);
	useEffect(() => {
		const onDone = async (event) => {
			if (event.detail?.type === "architecture") {
				setSyncing(true);
				cache.delete(project.id);
				await load();
			}
		};
		taskManager.addEventListener("task:completed", onDone);
		return () => taskManager.removeEventListener("task:completed", onDone);
	}, [load, project.id]);
	useEffect(() => {
		if (!canvasRef.current || !graph.nodes.length) return undefined;
		controllerRef.current?.destroy();
		controllerRef.current = renderGraph(canvasRef.current, graph, {
			mode: "architecture",
			layoutMode: viewMode,
			onSelect: (node) => {
				setSelectedNode(node);
				setSelectedEdge(null);
			},
			onSelectEdge: (edge) => {
				setSelectedEdge(edge);
				setSelectedNode(null);
			},
		});
		return () => {
			controllerRef.current?.destroy();
			controllerRef.current = null;
		};
	}, [graph, viewMode]);
	useEffect(() => {
		function onFullscreenChange() {
			const shell = shellRef.current;
			if (!shell) return;
			const svg = shell.querySelector(".graph-svg");
			const full = Boolean(document.fullscreenElement);
			shell.classList.toggle("is-fullscreen", full);
			if (svg) {
				if (full) {
					svg.style.height = "100vh";
					svg.style.maxHeight = "100vh";
				} else {
					svg.style.removeProperty("height");
					svg.style.removeProperty("max-height");
				}
			}
			controllerRef.current?.reset();
		}
		document.addEventListener("fullscreenchange", onFullscreenChange);
		return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
	}, []);

	function updateGraph(next) {
		setGraph(next);
		cache.set(project.id, { graph: next });
		setSelectedNode(null);
		setSelectedEdge(null);
	}
	async function runDelete(operation, confirmation, request) {
		// Lock before awaiting confirmation: double clicks must not create two requests.
		if (deleteLock.current || syncing) return;
		deleteLock.current = true;
		let submitted = false;
		try {
			if (!(await confirmDanger(confirmation)) || !mounted.current) return;
			submitted = true;
			loadVersion.current += 1;
			cache.delete(project.id);
			setDeleteNotice(null);
			setDeleting({ ...operation, startedAt: Date.now() });
			const result = await request();
			cache.delete(project.id);
			if (!mounted.current) return;
			const isNode = operation.kind.includes("node");
			const count = Number((isNode ? result.deleted_nodes : result.deleted_edges) ?? (result.deleted ? 1 : 0));
			const missing = Number((isNode ? result.not_found_nodes : result.not_found_edges) || 0);
			const message = count > 0
				? `已删除 ${count} ${isNode ? "个节点" : "条关系"}${isNode && result.deleted_edges != null ? `，清理 ${result.deleted_edges} 条相邻关系` : ""}${missing ? `；${missing} 项未找到或已被删除` : ""}。`
				: "未删除任何数据：所选节点或关系未找到或已被删除，请刷新核对。";
			if (result.graph) updateGraph(result.graph);
			setNodeSelection(new Set());
			setEdgeSelection(new Set());
			const warning = result.refresh_warning || (!result.graph ? "未能获取最新图谱，请刷新核对结果，不要重复提交删除。" : "");
			setDeleteNotice({ error: Boolean(warning) || !count || missing > 0, message: message + warning });
			toast(message + warning, warning || !count || missing ? "warning" : "success");
		} catch (err) {
			if (!mounted.current) return;
			const message = `删除请求未能完整完成：${err.message}。可能已有部分操作执行，请先刷新核对，不要直接重复删除。`;
			setDeleteNotice({ error: true, message });
			toast(message, "error");
		} finally {
			deleteLock.current = false;
			if (submitted && mounted.current) { setDeleting(null); setLoading(false); setSyncing(false); }
		}
	}
	function deleteNode(node) {
		if (!node) return;
		return runDelete(
			{ kind: "node", name: node.name, label: `正在删除节点“${node.name}”` },
			`删除节点“${node.name}”及其全部相邻关系？该操作不可恢复。`,
			() => api.batchDeleteNodes(project.id, [node.name]),
		);
	}
	function deleteEdge(edge) {
		if (!edge) return;
		return runDelete(
			{ kind: "edge", name: `${edge.source}|${edge.target}|${edge.type}`, label: "正在删除所选关系" },
			`删除关系“${edge.source} —[${edge.type}]→ ${edge.target}”？`,
			() => api.batchDeleteEdges(project.id, [edge]),
		);
	}
	function batchDeleteNodes() {
		const names = [...nodeSelection];
		if (!names.length) return;
		return runDelete(
			{ kind: "nodes", label: `正在批量删除 ${names.length} 个节点` },
			`确认批量删除选中的 ${names.length} 个节点及全部相邻关系？该操作不可恢复。`,
			() => api.batchDeleteNodes(project.id, names),
		);
	}
	function batchDeleteEdges() {
		// Resolve selected records instead of splitting names that may contain '|'.
		const edges = graph.edges.filter((edge) => edgeSelection.has(`${edge.source}|${edge.target}|${edge.type}`));
		if (!edges.length) return;
		return runDelete(
			{ kind: "edges", label: `正在批量删除 ${edges.length} 条关系` },
			`确认批量删除选中的 ${edges.length} 条关系？`,
			() => api.batchDeleteEdges(project.id, edges),
		);
	}
	async function submitArchitecture(event) {
		event.preventDefault();
		if (!file) return toast("请选择有效的架构描述文件 (.md / .txt)", "error");
		const data = new FormData();
		data.append("file", file);
		setImporting(true);
		try {
			await api.importArchitecture(project.id, data);
			toast("架构大模型抽取任务已在后台启动！您可以自由切换页面。", "info");
			setFile(null);
			setArchitectureFileList([]);
			await taskManager.pollNow();
		} catch (err) {
			toast(err.message, "error");
		} finally {
			setImporting(false);
		}
	}
	async function exportJson() {
		try {
			const data = await api.exportGraph(project.id);
			const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
			const a = document.createElement("a");
			a.href = url;
			a.download = `architecture_export_${project.name || project.id}.json`;
			a.click();
			URL.revokeObjectURL(url);
			toast("架构图谱数据已成功导出为 JSON");
		} catch (err) {
			toast(`导出失败：${err.message}`, "error");
		}
	}
	async function importJsonFile(selected) {
		if (!selected) return;
		try {
			const payload = JSON.parse(await selected.text());
			if (!payload || typeof payload !== "object") throw new Error("无效的 JSON 数据结构");
			toast("正在直接导入图谱数据…", "info");
			const res = await api.importGraphData(project.id, payload);
			updateGraph(res.graph);
			toast(`直接导入成功！已保存 ${res.imported_nodes} 个节点与 ${res.imported_edges} 条关系（未经过 LLM，秒级同步）`);
		} catch (err) {
			toast(`导入失败：${err.message}`, "error");
		}
	}
	function nodeRank(node, query) {
		const normalized = String(query || "")
			.trim()
			.toLocaleLowerCase();
		if (!normalized) return 4;
		const name = String(node.name || "").toLocaleLowerCase();
		const text = [node.name, node.kind, node.layer, node.description].join(" ").toLocaleLowerCase();
		if (name === normalized) return 0;
		if (name.startsWith(normalized)) return 1;
		if (name.includes(normalized)) return 2;
		return text.includes(normalized) ? 3 : 99;
	}
	function locateNode(query = nodeSearch) {
		const keyword = String(query || "").trim();
		if (!keyword) {
			controllerRef.current?.clearFocus();
			return toast("请输入节点名称或关键词", "info");
		}
		const match = graph.nodes
			.map((node) => ({ node, rank: nodeRank(node, keyword) }))
			.filter((item) => item.rank < 99)
			.sort((a, b) => a.rank - b.rank || a.node.name.localeCompare(b.node.name, "zh-CN"))[0]?.node;
		if (!match || !controllerRef.current?.focusNode(match.name))
			return toast(`没有找到与“${keyword}”匹配的架构节点`, "error");
		setNodeSearch(match.name);
		toast(`已定位“${match.name}”，并高亮其直接关联关系`, "info");
	}
	function searchNode(event) {
		event.preventDefault();
		locateNode();
	}
	async function toggleFullscreen() {
		const shell = shellRef.current;
		if (!shell) return;
		if (document.fullscreenElement) await document.exitFullscreen?.().catch(() => {});
		else {
			await shell.requestFullscreen?.().catch(() => {});
			toast("已开启 100% 沉浸全屏模式，再次点击或按 Esc 退出", "info");
		}
	}

	const nodeSearchData = useMemo(
		() =>
			graph.nodes
				.map((node) => ({ node, rank: nodeRank(node, nodeSearch) }))
				.filter((item) => !nodeSearch.trim() || item.rank < 99)
				.sort((a, b) => a.rank - b.rank || a.node.name.localeCompare(b.node.name, "zh-CN"))
				.slice(0, 10)
				.map(({ node }) => ({
					value: node.name,
					label: node.name,
					kind: node.kind || "Component",
					layer: node.layer || "未分层",
				})),
		[graph.nodes, nodeSearch],
	);

	const allNodes = graph.nodes.length > 0 && nodeSelection.size === graph.nodes.length;
	const allEdges = graph.edges.length > 0 && edgeSelection.size === graph.edges.length;
	const nodeColumns = [
		{
			title: (
				<Checkbox
					disabled={Boolean(deleting)}
					checked={allNodes}
					onChange={(e) =>
						setNodeSelection(e.target.checked ? new Set(graph.nodes.map((node) => node.name)) : new Set())
					}
					aria-label="全选节点"
				/>
			),
			width: 48,
			render: (_, node) => (
				<Checkbox
					disabled={Boolean(deleting)}
					checked={nodeSelection.has(node.name)}
					onChange={(e) =>
						setNodeSelection((previous) => {
							const next = new Set(previous);
							e.target.checked ? next.add(node.name) : next.delete(node.name);
							return next;
						})
					}
					aria-label={`选择节点 ${node.name}`}
				/>
			),
		},
		{
			title: "节点",
			render: (_, node) => (
				<>
					<strong>{node.name}</strong>
					<span className="table-subtitle">{node.description || node.layer || "—"}</span>
				</>
			),
		},
		{
			title: "类型",
			dataIndex: "kind",
			render: (value) => <Tag color="blue">{value}</Tag>,
		},
		{
			title: "操作",
			width: 150,
			render: (_, node) => (
				<div className="row-actions">
					<AppButton
						icon={<IconEditStroked />}
						className="button button-secondary button-small"
						type="button"
						onClick={() => setModal({ type: "node", value: node })}
						disabled={Boolean(deleting)}
					>
						编辑
					</AppButton>
					<AppButton
						icon={<IconDeleteStroked />}
						className="button button-danger button-small"
						type="button"
						onClick={() => deleteNode(node)}
						disabled={Boolean(deleting) || syncing}
						loading={deleting?.kind === "node" && deleting?.name === node.name}
					>
						删除
					</AppButton>
				</div>
			),
		},
	];
	const edgeColumns = [
		{
			title: (
				<Checkbox
					disabled={Boolean(deleting)}
					checked={allEdges}
					onChange={(e) =>
						setEdgeSelection(
							e.target.checked
								? new Set(graph.edges.map((edge) => `${edge.source}|${edge.target}|${edge.type}`))
								: new Set(),
						)
					}
					aria-label="全选关系"
				/>
			),
			width: 48,
			render: (_, edge) => {
				const key = `${edge.source}|${edge.target}|${edge.type}`;
				return (
					<Checkbox
						disabled={Boolean(deleting)}
						checked={edgeSelection.has(key)}
						onChange={(e) =>
							setEdgeSelection((previous) => {
								const next = new Set(previous);
								e.target.checked ? next.add(key) : next.delete(key);
								return next;
							})
						}
						aria-label={`选择关系 ${edge.source} 到 ${edge.target}`}
					/>
				);
			},
		},
		{
			title: "关系",
			render: (_, edge) => (
				<>
					<strong>
						{edge.source} → {edge.target}
					</strong>
					<span className="table-subtitle">{edge.description || "—"}</span>
				</>
			),
		},
		{
			title: "类型",
			dataIndex: "type",
			render: (value) => <Tag color="cyan">{value}</Tag>,
		},
		{
			title: "操作",
			width: 150,
			render: (_, edge) => (
				<div className="row-actions">
					<AppButton
						icon={<IconEditStroked />}
						className="button button-secondary button-small"
						type="button"
						onClick={() => setModal({ type: "edge", value: edge })}
						disabled={Boolean(deleting)}
					>
						编辑
					</AppButton>
					<AppButton
						icon={<IconDeleteStroked />}
						className="button button-danger button-small"
						type="button"
						onClick={() => deleteEdge(edge)}
						disabled={Boolean(deleting) || syncing}
						loading={deleting?.kind === "edge" && deleting?.name === `${edge.source}|${edge.target}|${edge.type}`}
					>
						删除
					</AppButton>
				</div>
			),
		},
	];

	if (loading && !graph.nodes.length) return <LoadingState message="正在读取架构图谱…" />;
	if (error && !graph.nodes.length) return <ErrorState error={error} onRetry={() => load()} />;

	return (
		<>
			<div className="page-header">
				<div>
					<h1>系统架构拓扑</h1>
					<p>这里只展示静态系统架构；故障、日志事件和 RCA 节点仅在具体故障详情中融合展示。</p>
				</div>
			</div>

			<details
				className="card architecture-import"
				style={{ marginBottom: 20 }}
				open={graph.nodes.length === 0 || activeTask ? true : undefined}
				onToggle={() => {}}
			>
				<summary>
					<span>
						<strong>从架构描述文本增量抽取 (LLM 大模型)</strong>
						<small>使用大模型增量抽取节点与依赖关系</small>
					</span>
					<span className="details-summary-action">
						展开上传 <IconChevronDown size="small" />
					</span>
				</summary>
				<div className="card-body">
					<TechTaskCard task={activeTask} title="架构大模型抽取处理中" steps={taskSteps} />
					<form className="form-stack" onSubmit={submitArchitecture}>
						<div className="field">
							<label>架构文本文件</label>
							<Upload
								action="#"
								draggable
								limit={1}
								accept=".txt,.md,text/plain,text/markdown"
								fileList={architectureFileList}
								dragMainText={file?.name || "点击选择或拖拽架构描述"}
								dragSubText="支持 UTF-8 的 .md / .txt"
								dragIcon={<IconUpload size="extra-large" />}
								beforeUpload={({ file: item }) => {
									setFile(item.fileInstance);
									return { shouldUpload: false, autoRemove: false };
								}}
								onChange={({ fileList }) => setArchitectureFileList([...fileList])}
								onRemove={() => {
									setFile(null);
									setArchitectureFileList([]);
								}}
							/>
						</div>
						<div>
							<AppButton className="button button-primary" type="submit" disabled={importing || Boolean(activeTask) || Boolean(deleting)}>
								{importing ? "正在启动后台任务…" : activeTask ? "后台处理中..." : "大模型抽取并更新图谱"}
							</AppButton>
						</div>
					</form>
				</div>
			</details>

			{deleteNotice ? (
				<div className={`notice ${deleteNotice.error ? "notice-warning" : "notice-success"}`} role="status" style={{ marginBottom: 16 }}>
					{deleteNotice.message}
					<AppButton className="button button-secondary button-small" style={{ marginLeft: 12 }} disabled={Boolean(deleting) || syncing} loading={syncing} onClick={() => load()}>
						刷新核对
					</AppButton>
				</div>
			) : null}
			{error && graph.nodes.length ? <div className="notice notice-warning" role="alert">刷新失败：{error.message}</div> : null}
			<section className="card architecture-graph-card" style={{ marginBottom: 20 }}>
				<div className="card-header architecture-graph-header">
					<div>
						<h2>架构拓扑</h2>
						<p>
							{graph.nodes.length} 个架构节点 · {graph.edges.length} 条架构关系；点击节点或连线可直接管理。
						</p>
					</div>
					<div className="architecture-card-actions">
						<AppButton
							icon={<IconDownload />}
							className="button button-secondary button-small"
							type="button"
							onClick={exportJson}
						>
							导出
						</AppButton>
						<Upload
							action="#"
							accept=".json,application/json"
							showUploadList={false}
							beforeUpload={({ file: item }) => {
								importJsonFile(item.fileInstance);
								return { shouldUpload: false, autoRemove: true };
							}}
						>
							<AppButton icon={<IconUpload />} className="button button-secondary button-small" type="button">
								导入
							</AppButton>
						</Upload>
						<AppButton
							icon={<IconPlus />}
							className="button button-secondary button-small"
							type="button"
							onClick={() => setModal({ type: "node" })}
						>
							节点
						</AppButton>
						<AppButton
							icon={<IconPlus />}
							className="button button-primary button-small"
							type="button"
							onClick={() =>
								graph.nodes.length >= 2 ? setModal({ type: "edge" }) : toast("至少需要两个节点才能创建关系", "error")
							}
						>
							关系
						</AppButton>
						<AppButton
							icon={<IconRefresh />}
							className="button button-secondary button-small"
							type="button"
							onClick={() => load()}
							disabled={Boolean(deleting) || syncing}
							loading={syncing}
						>
							刷新
						</AppButton>
					</div>
				</div>
				<div className="card-body" style={{ position: "relative" }}>
					{syncing ? (
						<div className="architecture-sync-overlay">
							<LoadingState message="正在同步并渲染最新拓扑图谱…" />
						</div>
					) : null}
					{graph.warnings?.length ? (
						<div className="notice notice-warning" style={{ marginBottom: 12 }}>
							{graph.warnings.join("；")}
						</div>
					) : null}
					{graph.nodes.length ? (
						<>
							<div className="architecture-graph-controls">
								<div className="graph-view-switch" role="group" aria-label="图谱展示方式">
									<AppButton
										type="button"
										className={`graph-view-option${viewMode === "force" ? " active" : ""}`}
										onClick={() => setViewMode("force")}
									>
										关系图
									</AppButton>
									<AppButton
										type="button"
										className={`graph-view-option${viewMode === "swimlane" ? " active" : ""}`}
										onClick={() => setViewMode("swimlane")}
									>
										泳道图
									</AppButton>
								</div>
								<form className="graph-node-search" role="search" onSubmit={searchNode}>
									<AutoComplete
										className="graph-node-search-input"
										data={nodeSearchData}
										value={nodeSearch}
										showClear
										prefix={<IconSearch size="small" />}
										placeholder="搜索节点名称、类型或架构层…"
										aria-label="搜索架构节点"
										onSearch={setNodeSearch}
										onChange={(value) => {
											setNodeSearch(String(value || ""));
											if (!String(value || "").trim()) controllerRef.current?.clearFocus();
										}}
										onSelect={(value) => locateNode(value)}
										renderItem={(item) => (
											<div className="graph-node-option">
												<strong>{item.value}</strong>
												<span>
													{item.kind} · {item.layer}
												</span>
											</div>
										)}
									/>
									<AppButton className="button button-primary button-small" type="submit">
										定位节点
									</AppButton>
								</form>
							</div>
							<div className="architecture-canvas-layout">
								<div className="graph-shell graph-shell-primary" ref={shellRef} data-layout-mode={viewMode}>
									<div ref={canvasRef} />
									<div className="graph-toolbar">
										<AppButton
											icon={<IconFullScreenStroked />}
											className="button button-ghost button-small"
											type="button"
											onClick={toggleFullscreen}
											title="全屏查看图谱"
										>
											全屏
										</AppButton>
										<AppButton
											icon={<IconSync />}
											className="button button-ghost button-small"
											type="button"
											onClick={() => controllerRef.current?.relayout()}
											title="重新计算节点布局"
										>
											重新布局
										</AppButton>
										<AppButton
											icon={<IconMinus />}
											className="button button-ghost button-small graph-icon-button"
											type="button"
											onClick={() => controllerRef.current?.zoomOut()}
											title="缩小"
											aria-label="缩小图谱"
										/>
										<AppButton
											icon={<IconWindowAdaptionStroked />}
											className="button button-ghost button-small"
											type="button"
											onClick={() => controllerRef.current?.reset()}
										>
											适配画布
										</AppButton>
										<AppButton
											icon={<IconPlus />}
											className="button button-ghost button-small graph-icon-button"
											type="button"
											onClick={() => controllerRef.current?.zoomIn()}
											title="放大"
											aria-label="放大图谱"
										/>
									</div>
									<GraphLegend />
								</div>
								<aside className="graph-selection-panel">
									<Inspector
										selectedNode={selectedNode}
										selectedEdge={selectedEdge}
										graph={graph}
										deleting={deleting}
										onEditNode={() => setModal({ type: "node", value: selectedNode })}
										onDeleteNode={() => deleteNode(selectedNode)}
										onEditEdge={() => setModal({ type: "edge", value: selectedEdge })}
										onDeleteEdge={() => deleteEdge(selectedEdge)}
									/>
								</aside>
							</div>
						</>
					) : (
						<EmptyState title="架构图谱还是空的" detail="导入架构描述，或手工新增第一个架构节点。">
							<AppButton
								icon={<IconPlus />}
								className="button button-primary"
								type="button"
								onClick={() => setModal({ type: "node" })}
							>
								新增节点
							</AppButton>
						</EmptyState>
					)}
				</div>
			</section>

			<div className="grid grid-2" style={{ marginBottom: 20 }}>
				<section className="card">
					<div className="card-header">
						<div>
							<h2>节点管理</h2>
							<p>编辑名称、类型、层级和描述。</p>
						</div>
						<div className="row-actions">
							<AppButton
								icon={<IconDeleteStroked />}
								className="button button-danger button-small"
								type="button"
								disabled={!nodeSelection.size || Boolean(deleting) || syncing}
								loading={deleting?.kind === "nodes"}
								onClick={batchDeleteNodes}
							>
								批量删除 ({nodeSelection.size})
							</AppButton>
							<AppButton
								icon={<IconPlus />}
								className="button button-secondary button-small"
								type="button"
								onClick={() => setModal({ type: "node" })}
							>
								节点
							</AppButton>
						</div>
					</div>
					<div className="card-body flush management-table">
						{graph.nodes.length ? (
							<Table
								className="logscope-semi-table"
								columns={nodeColumns}
								dataSource={graph.nodes}
								rowKey="name"
								pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOpts: [20, 50, 100] }}
								scroll={{ y: 350 }}
							/>
						) : (
							<EmptyState title="没有架构节点" detail="点击新增节点开始维护。" />
						)}
					</div>
				</section>
				<section className="card">
					<div className="card-header">
						<div>
							<h2>关系管理</h2>
							<p>维护依赖方向、关系类型和说明。</p>
						</div>
						<div className="row-actions">
							<AppButton
								icon={<IconDeleteStroked />}
								className="button button-danger button-small"
								type="button"
								disabled={!edgeSelection.size || Boolean(deleting) || syncing}
								loading={deleting?.kind === "edges"}
								onClick={batchDeleteEdges}
							>
								批量删除 ({edgeSelection.size})
							</AppButton>
							<AppButton
								icon={<IconPlus />}
								className="button button-secondary button-small"
								type="button"
								onClick={() =>
									graph.nodes.length >= 2 ? setModal({ type: "edge" }) : toast("至少需要两个节点才能创建关系", "error")
								}
							>
								关系
							</AppButton>
						</div>
					</div>
					<div className="card-body flush management-table">
						{graph.edges.length ? (
							<Table
								className="logscope-semi-table"
								columns={edgeColumns}
								dataSource={graph.edges}
								rowKey={(edge) => `${edge.source}|${edge.target}|${edge.type}`}
								pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOpts: [20, 50, 100] }}
								scroll={{ y: 350 }}
							/>
						) : (
							<EmptyState title="没有架构关系" detail="创建关系后 RCA 才能沿依赖图查找传播链。" />
						)}
					</div>
				</section>
			</div>

			{deleting ? (
				<SemiModal
					visible
					title="正在处理图谱删除"
					footer={null}
					closable={false}
					maskClosable={false}
					closeOnEsc={false}
					width="min(520px, calc(100vw - 32px))"
					getPopupContainer={() => document.fullscreenElement || document.body}
				>
					<GraphDeleteProgress operation={deleting} />
				</SemiModal>
			) : null}
			{modal?.type === "node" ? (
				<NodeModal
					projectId={project.id}
					node={modal.value || null}
					graph={graph}
					onClose={() => setModal(null)}
					onSaved={updateGraph}
				/>
			) : null}
			{modal?.type === "edge" ? (
				<EdgeModal
					projectId={project.id}
					edge={modal.value || null}
					graph={graph}
					selectedNode={selectedNode}
					onClose={() => setModal(null)}
					onSaved={updateGraph}
				/>
			) : null}
		</>
	);
}
