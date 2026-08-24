import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Checkbox, Pagination, Table, Tag } from "@douyinfe/semi-ui";
import { IconClear, IconCrossCircleStroked, IconDeleteStroked, IconDownload, IconRefresh, IconSearch, IconTickCircle } from "@douyinfe/semi-icons";
import { api } from "../utils/api.js";
import { formatDate, toast } from "../utils/ui.js";
import { BusyButton, EmptyState, ErrorState, LoadingState, Modal } from "../components/Ui.jsx";
import { AppButton, AppInput, AppSelect } from "../components/SemiAdapter.jsx";

const number = (value) => new Intl.NumberFormat("zh-CN").format(Number(value || 0));
const actionLabel = (action) => ({ clear_project: "清空项目图谱", cleanup_batch: "清理批次动态图谱", delete_orphan_nodes: "删除孤立节点" }[action] || action);
const statusLabel = (status) => ({ previewed: "待确认", running: "执行中", completed: "已完成", failed: "失败" }[status] || status);
const statusColor = (status) => ({ previewed: "#d97706", running: "#2563eb", completed: "#16a34a", failed: "#dc2626" }[status] || "#64748b");
const riskLabel = (risk) => ({ high: "高", medium: "中", low: "低" }[risk] || risk);

function MetricCard({ label, value, color, detail }) {
  return <section className="card" style={{ padding: 16 }}><span style={{ fontSize: 12, color: "var(--ink-500)" }}>{label}</span><strong style={{ display: "block", fontSize: 24, color, margin: "5px 0" }}>{value}</strong><small style={{ color: "var(--ink-500)" }}>{detail}</small></section>;
}

function QualityMetric({ label, value, hasIssue, detail }) {
  return <div className="quality-metric"><span>{label}</span><strong style={{ color: hasIssue ? "#dc2626" : "#16a34a" }}>{value}</strong><small>{detail}</small></div>;
}

function SchemaState({ label, ready }) {
  return <span className="schema-state"><span style={{ color: ready ? "#16a34a" : "#dc2626", fontWeight: 600 }}>{ready ? <IconTickCircle size="small" /> : <IconCrossCircleStroked size="small" />}{ready ? "已就绪" : "未发现"}</span><code style={{ fontSize: 11 }}>{label || "-"}</code></span>;
}

function Distribution({ title, items = [] }) {
  return <div><strong style={{ display: "block", fontSize: 12, marginBottom: 8 }}>{title}</strong><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{items.length ? items.slice(0, 10).map((item) => <span key={`${title}-${item.name}`} style={{ fontSize: 11, padding: "4px 7px", background: "var(--surface-soft)", border: "1px solid var(--border)", borderRadius: 5 }}>{item.name} <strong>{number(item.count)}</strong></span>) : <span style={{ fontSize: 12, color: "var(--ink-400)" }}>暂无数据</span>}</div></div>;
}

function OperationTable({ items = [] }) {
  if (!items.length) return <div style={{ padding: 20 }}><EmptyState title="暂无管理操作" detail="执行过的预览和维护结果会显示在这里。" /></div>;
  const columns = [
    { title: "时间 / 操作人", dataIndex: "created_at", render: (_, item) => <>{formatDate(item.created_at)}<small className="table-subtitle">{item.actor_display_name || item.actor_username || item.actor_id}</small></> },
    { title: "操作", dataIndex: "action", render: (_, item) => <><strong>{actionLabel(item.action)}</strong><small className="table-subtitle">{item.target_id || "-"}</small></> },
    { title: "目标项目", dataIndex: "project_name", render: (_, item) => item.project_name || item.preview?.project_name || "项目已删除" },
    { title: "预览影响", dataIndex: "preview", render: (_, item) => <>节点 {number(item.preview?.affected_nodes)} · 关系 {number(item.preview?.affected_edges)}</> },
    { title: "状态 / 结果", dataIndex: "status", render: (_, item) => <><Tag color={item.status === "completed" ? "green" : item.status === "failed" ? "red" : item.status === "running" ? "blue" : "amber"}>{statusLabel(item.status)}</Tag>{item.error_message ? <small className="table-subtitle" style={{ color: "#dc2626", maxWidth: 340, wordBreak: "break-word" }}>{item.error_message}</small> : Object.entries(item.result || {}).length ? <small className="table-subtitle">{Object.entries(item.result || {}).map(([key, value]) => `${key} ${number(value)}`).join(" · ")}</small> : null}</> },
  ];
  return <Table className="logscope-semi-table" columns={columns} dataSource={items} rowKey="id" pagination={false} />;
}

function GraphExplorer({ projects }) {
  const [filters, setFilters] = useState({ entity: "nodes", project_id: "", category: "", q: "" });
  const [query, setQuery] = useState({ ...filters, page: 1 });
  const [state, setState] = useState({ loading: true, result: null, error: null });

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try { setState({ loading: false, result: await api.adminGraphData({ ...query, page_size: 20 }), error: null }); }
    catch (error) { setState({ loading: false, result: null, error }); }
  }, [query]);
  useEffect(() => { load(); }, [load]);

  const submit = (event) => {
    event.preventDefault();
    setQuery({ ...filters, category: filters.category.trim(), q: filters.q.trim(), page: 1 });
  };
  const result = state.result;
  const nodes = result?.entity === "nodes";
  const columns = nodes ? [
    { title: "节点名称", dataIndex: "name", render: (_, item) => <><strong>{item.name}</strong><small className="table-subtitle">{item.description || item.internal_name}</small></> },
    { title: "类型 / 层级", dataIndex: "kind", render: (_, item) => <>{item.kind}<small className="table-subtitle">{item.layer}</small></> },
    { title: "项目", dataIndex: "project_name" },
    { title: "来源", dataIndex: "source_file", render: (value) => value || "-" },
  ] : [
    { title: "起点 → 终点", dataIndex: "source", render: (_, item) => <><strong>{item.source}</strong> → <strong>{item.target}</strong><small className="table-subtitle">{item.description || ""}</small></> },
    { title: "关系类型", dataIndex: "relation" },
    { title: "项目", dataIndex: "project_name" },
    { title: "有效性", dataIndex: "valid", render: (valid) => <Tag color={valid ? "green" : "red"}>{valid ? "有效" : "端点缺失"}</Tag> },
  ];

  return <section className="card" style={{ marginBottom: 16 }}>
    <div className="card-header"><div><h2>图谱数据浏览</h2><p>按项目、类型和关键词分页查看节点或关系，当前只读。</p></div></div>
    <div className="card-body">
      <form className="graph-admin-filters" onSubmit={submit}>
        <div className="field"><label>数据对象</label><AppSelect className="select" value={filters.entity} onChange={(e) => setFilters((value) => ({ ...value, entity: e.target.value }))}><option value="nodes">节点</option><option value="edges">关系</option></AppSelect></div>
        <div className="field"><label>所属项目</label><AppSelect className="select" value={filters.project_id} onChange={(e) => setFilters((value) => ({ ...value, project_id: e.target.value }))}><option value="">全部项目</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</AppSelect></div>
        <div className="field"><label>类型</label><AppInput className="input" value={filters.category} onChange={(e) => setFilters((value) => ({ ...value, category: e.target.value }))} placeholder="如 Service / CALLS" /></div>
        <div className="field"><label>关键词</label><AppInput className="input" value={filters.q} onChange={(e) => setFilters((value) => ({ ...value, q: e.target.value }))} placeholder="名称、描述、来源文件" /></div>
        <AppButton icon={<IconSearch />} className="button button-primary" type="submit">查询</AppButton>
      </form>
      <div style={{ marginTop: 14 }}>
        {state.loading ? <LoadingState message="正在查询图谱数据…" /> : state.error ? <ErrorState error={state.error} onRetry={load} /> : !result?.items?.length ? <EmptyState title="没有匹配数据" detail="调整项目、类型或关键词后重试。" /> : <>
          <Table className="logscope-semi-table graph-admin-scroll" columns={columns} dataSource={result.items} rowKey={(item) => item.id || (item.name ? `node:${item.name}` : `edge:${item.source}|${item.target}|${item.relation}`)} pagination={false} />
          <div className="semi-pagination-row"><span>共 {number(result.total)} 条</span><Pagination currentPage={result.page} pageSize={20} total={result.total} showTotal={false} onPageChange={(page) => setQuery((value) => ({ ...value, page }))} /></div>
        </>}
      </div>
    </div>
  </section>;
}

function qualityRows(quality) {
  return [
    ...(quality.orphan_nodes || []).map((item, index) => ({ issue: "孤立节点", target: item.name, type: item.kind, reason: item.likely_reason, suggestion: item.suggestion, risk: item.deletion_risk, orphanIndex: index })),
    ...(quality.invalid_edges || []).map((item) => ({ issue: "无效关系", target: `${item.source} → ${item.target}`, type: item.relation, reason: "关系起点或终点在当前图谱中不存在", suggestion: "核对关系写入和节点清理记录" })),
    ...(quality.duplicate_edges || []).map((item) => ({ issue: "重复关系", target: `${item.source} → ${item.target}`, type: `${item.relation} × ${item.count}`, reason: "存在相同起点、终点和类型的多条关系", suggestion: "保留一条有效关系并检查重复导入来源" })),
    ...(quality.cross_project_edges || []).map((item) => ({ issue: "跨项目关系", target: `${item.source} → ${item.target}`, type: item.relation, reason: `起点属于 ${item.source_project_id}，终点属于 ${item.target_project_id}`, suggestion: "检查项目命名空间和导入数据是否串用" })),
    ...(quality.unknown_project_nodes || []).map((item) => ({ issue: "失效项目归属", target: item.name, type: item.kind, reason: `引用不存在的项目 ${item.project_id}`, suggestion: "核对项目是否已删除，再决定迁移或清理节点" })),
    ...(quality.unscoped_nodes || []).filter((item) => !(quality.orphan_nodes || []).some((orphan) => orphan.id === item.id)).map((item) => ({ issue: "未归属节点", target: item.name, type: item.kind, reason: item.likely_reason, suggestion: item.suggestion, risk: item.deletion_risk })),
  ].slice(0, 200);
}

function OperationModal({ action, project, selectedNames = [], onClose, onCompleted }) {
  const [batches, setBatches] = useState([]);
  const [targetId, setTargetId] = useState("");
  const [loading, setLoading] = useState(action === "cleanup_batch");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState(null);
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    if (action !== "cleanup_batch") return;
    api.adminGraphBatches(project.id).then(({ items }) => { setBatches(items || []); setTargetId(items?.[0]?.id || ""); setLoading(false); }).catch((err) => { setError(err); setLoading(false); });
  }, [action, project.id]);

  const preview = async () => {
    setBusy(true);
    try {
      const response = action === "delete_orphan_nodes" ? await api.previewDeleteOrphanNodes(project.id, selectedNames) : await api.previewAdminGraphOperation({ action, project_id: project.id, target_id: targetId });
      setOperation(response.operation);
    } catch (err) { toast(err.message, "error"); } finally { setBusy(false); }
  };

  const execute = async () => {
    if (confirmation !== operation.confirmation_text) return toast("二次确认文本不匹配", "error");
    setBusy(true);
    try { await api.executeAdminGraphOperation(operation.id, confirmation); toast("图谱维护操作执行完成"); onClose(); await onCompleted(); }
    catch (err) { toast(err.message, "error"); setBusy(false); }
  };

  return <Modal title={actionLabel(action)} onClose={onClose} maxWidth={560}>
    {loading ? <LoadingState message="正在准备操作范围…" /> : error ? <ErrorState error={error} /> : action === "cleanup_batch" && !batches.length ? <EmptyState title="没有可选日志批次" detail="该项目尚无日志分析批次。" /> : !operation ? <>
      <div style={{ padding: "11px 13px", borderRadius: 7, background: "#fff7ed", border: "1px solid #fed7aa", color: "#9a3412", fontSize: 12, marginBottom: 14 }}>该操作会删除 HugeGraph 数据且无法撤销。第一步只生成影响预览，不会修改数据。</div>
      <div className="field"><label>目标项目</label><AppInput className="input" value={project.name} disabled /></div>
      {action === "cleanup_batch" ? <div className="field" style={{ marginTop: 12 }}><label>目标日志批次</label><AppSelect className="select" value={targetId} onChange={(e) => setTargetId(e.target.value)}>{batches.map((item) => <option key={item.id} value={item.id}>{item.filename} · {formatDate(item.created_at)}</option>)}</AppSelect></div> : null}
      {action === "delete_orphan_nodes" ? <div style={{ marginTop: 12 }}><strong style={{ fontSize: 12 }}>已选择 {number(selectedNames.length)} 个孤立节点</strong><div style={{ maxHeight: 130, overflow: "auto", marginTop: 7, padding: 9, border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", fontSize: 11, wordBreak: "break-all" }}>{selectedNames.join("、")}</div></div> : null}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 9, marginTop: 18 }}><AppButton className="button button-secondary" onClick={onClose}>取消</AppButton><BusyButton className="button button-primary" busy={busy} busyText="扫描中…" onClick={preview}>生成影响预览</BusyButton></div>
    </> : <>
      <h3 style={{ margin: "0 0 7px" }}>确认影响范围</h3>
      <p style={{ fontSize: 13, color: "var(--ink-600)" }}>{operation.preview?.description || ""}</p>
      <div className="grid grid-2" style={{ margin: "14px 0" }}><MetricCard label="预计删除节点" value={number(operation.preview?.affected_nodes)} color="#dc2626" detail="基于当前实时快照" /><MetricCard label="预计影响关系" value={number(operation.preview?.affected_edges)} color="#dc2626" detail="节点删除时一并移除" /></div>
      {operation.preview?.node_samples?.length ? <details style={{ marginBottom: 14 }}><summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>查看节点样本</summary><div style={{ fontSize: 11, color: "var(--ink-500)", marginTop: 7, wordBreak: "break-all" }}>{operation.preview.node_samples.join("、")}</div></details> : null}
      <div className="field"><label>二次确认：请输入 <code>{operation.confirmation_text}</code></label><AppInput className="input" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="off" placeholder="必须完全一致" /></div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 9, marginTop: 18 }}><AppButton className="button button-secondary" onClick={onClose}>取消</AppButton><BusyButton className="button button-primary" style={{ background: "#dc2626", borderColor: "#dc2626" }} busy={busy} busyText="执行中…" onClick={execute}>确认并执行</BusyButton></div>
    </>}
  </Modal>;
}

function QualityCheck({ projects, onOperationCompleted }) {
  const [projectId, setProjectId] = useState("");
  const [state, setState] = useState({ loading: false, quality: null, error: null });
  const [selected, setSelected] = useState(new Set());
  const [operation, setOperation] = useState(null);

  const run = async () => {
    setState({ loading: true, quality: null, error: null }); setSelected(new Set());
    try { const { quality } = await api.adminGraphQuality(projectId); setState({ loading: false, quality, error: null }); }
    catch (error) { setState({ loading: false, quality: null, error }); }
  };
  const quality = state.quality;
  const rows = useMemo(() => quality ? qualityRows(quality) : [], [quality]);
  const project = projects.find((item) => String(item.id) === String(projectId));

  const toggle = (index) => setSelected((old) => { const next = new Set(old); if (next.has(index)) next.delete(index); else next.add(index); return next; });
  const toggleAll = () => setSelected((old) => old.size === (quality?.orphan_nodes || []).length ? new Set() : new Set((quality?.orphan_nodes || []).map((_, i) => i)));

  return <section className="card" style={{ marginBottom: 16 }}>
    <div className="card-header"><div><h2>图谱质量检查</h2><p>检查孤立节点、无效关系、重复关系和未归属项目节点；检查本身不会修改数据。</p></div></div>
    <div className="card-body">
      <div style={{ display: "flex", gap: 9, alignItems: "end", flexWrap: "wrap" }}><div className="field" style={{ minWidth: 260 }}><label>检查范围</label><AppSelect className="select" value={projectId} onChange={(e) => { setProjectId(e.target.value); setState({ loading: false, quality: null, error: null }); setSelected(new Set()); }}><option value="">全局图谱</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</AppSelect></div><BusyButton className="button button-primary" busy={state.loading} busyText="检查中…" onClick={run}>开始检查</BusyButton></div>
      <div style={{ marginTop: 14, color: "var(--ink-500)", fontSize: 13 }}>
        {!quality && !state.error && !state.loading ? "选择范围后执行质量检查。" : state.loading ? <LoadingState message="正在扫描节点和关系…" /> : state.error ? <span style={{ color: "#dc2626" }}>{state.error.message}</span> : <>
          <div className="quality-summary" style={{ marginBottom: 12 }}>
            <QualityMetric label="孤立节点" value={number(quality.summary.orphan_nodes)} hasIssue={quality.summary.orphan_nodes} detail="无有效关系连接" />
            <QualityMetric label="无效关系" value={number(quality.summary.invalid_edges)} hasIssue={quality.summary.invalid_edges} detail="起点或终点缺失" />
            <QualityMetric label="重复关系" value={number(quality.summary.duplicate_edge_groups)} hasIssue={quality.summary.duplicate_edge_groups} detail="完全相同的关系" />
            <QualityMetric label="未归属节点" value={number(quality.summary.unscoped_nodes)} hasIssue={quality.summary.unscoped_nodes} detail="缺少项目命名空间" />
            <QualityMetric label="跨项目关系" value={number(quality.summary.cross_project_edges)} hasIssue={quality.summary.cross_project_edges} detail="关系跨越项目" />
            <QualityMetric label="失效项目归属" value={number(quality.summary.unknown_project_nodes)} hasIssue={quality.summary.unknown_project_nodes} detail="项目已不存在" />
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, margin: "4px 0 10px", flexWrap: "wrap" }}><span style={{ fontSize: 11, color: "var(--ink-400)" }}>检查时间：{formatDate(quality.checked_at)} · 问题样本最多展示 {number(quality.sample_limit)} 条</span>{projectId ? <AppButton icon={<IconDeleteStroked />} className="button button-ghost button-small" disabled={!selected.size} onClick={() => project && setOperation({ action: "delete_orphan_nodes", project })} style={{ color: "#dc2626", border: "1px solid rgba(220,38,38,.25)" }}>删除选中孤立节点{selected.size ? `（${selected.size}）` : ""}</AppButton> : <span style={{ fontSize: 11, color: "#b45309" }}>如需删除孤立节点，请先选择具体项目后重新检查</span>}</div>
          {!rows.length ? <div style={{ padding: 14, border: "1px solid #bbf7d0", background: "#f0fdf4", color: "#166534", borderRadius: 8 }}>当前范围未发现图谱质量问题。</div> : <Table className="logscope-semi-table graph-admin-scroll graph-quality-scroll" pagination={false} rowKey={(row) => `${row.issue}|${row.target}|${row.type || ""}`} dataSource={rows} columns={[{ title: projectId && quality.orphan_nodes?.length ? <Checkbox checked={selected.size === quality.orphan_nodes.length && selected.size > 0} onChange={toggleAll} aria-label="全选当前孤立节点" /> : null, width: 48, render: (_, row) => row.orphanIndex !== undefined && projectId ? <Checkbox checked={selected.has(row.orphanIndex)} onChange={() => toggle(row.orphanIndex)} aria-label={`选择 ${row.target}`} /> : null }, { title: "问题 / 对象", render: (_, row) => <><strong>{row.issue}</strong><span style={{ display: "block", fontSize: 12, marginTop: 3, wordBreak: "break-all" }}>{row.target}</span><small style={{ color: "var(--ink-400)" }}>{row.type || "-"}{row.risk ? ` · 删除风险 ${riskLabel(row.risk)}` : ""}</small></> }, { title: "可能原因", dataIndex: "reason", render: (value) => value || "-" }, { title: "处理建议", dataIndex: "suggestion", render: (value) => value || "-" }]} />}
        </>}
      </div>
      {operation ? <OperationModal action={operation.action} project={operation.project} selectedNames={[...selected].map((i) => quality.orphan_nodes[i]?.name).filter(Boolean)} onClose={() => setOperation(null)} onCompleted={async () => { setOperation(null); await run(); await onOperationCompleted(); }} /> : null}
    </div>
  </section>;
}

export function GraphAdminPage() {
  const [state, setState] = useState({ loading: true, connection: null, overview: null, operations: [], error: null });
  const [operation, setOperation] = useState(null);
  const [exporting, setExporting] = useState("");

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const [{ status }, { overview }, { items: operations }] = await Promise.all([api.adminGraphStatus(), api.adminGraphOverview(), api.adminGraphOperations(50)]);
      setState({ loading: false, connection: status, overview, operations, error: null });
    } catch (error) { setState({ loading: false, connection: null, overview: null, operations: [], error }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const refreshOperations = async () => {
    try { const { items } = await api.adminGraphOperations(50); setState((s) => ({ ...s, operations: items })); }
    catch (error) { toast(error.message, "error"); }
  };

  const exportProject = async (project) => {
    setExporting(project.id);
    try {
      const data = await api.adminGraphExport(project.id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `${project.name}-graph.json`; link.click(); URL.revokeObjectURL(url); toast(`项目“${project.name}”图谱已导出`);
    } catch (error) { toast(error.message, "error"); } finally { setExporting(""); }
  };

  if (state.loading && !state.overview) return <><div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}><div><h1>HugeGraph 图谱管理</h1><p>查看连接与 Schema 状态、数据规模和质量，并对明确目标执行可审计的安全维护。</p></div><AppButton icon={<IconRefresh />} className="button button-secondary" onClick={load}>刷新全部</AppButton></div><LoadingState message="正在读取 HugeGraph 状态与数据概览…" /></>;
  if (state.error) return <><div className="page-header"><div><h1>HugeGraph 图谱管理</h1></div></div><ErrorState error={state.error} onRetry={load} /></>;

  const connection = state.connection || {};
  const overview = state.overview || {};
  const totals = overview.totals || {};
  const online = connection.status === "ok";
  const truncated = overview.scan?.nodes_truncated || overview.scan?.edges_truncated;
  const projects = overview.projects || [];

  return <>
    <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}><div><h1>HugeGraph 图谱管理</h1><p>查看连接与 Schema 状态、数据规模和质量，并对明确目标执行可审计的安全维护。</p></div><AppButton icon={<IconRefresh />} className="button button-secondary" onClick={load}>刷新全部</AppButton></div>
    {truncated ? <div className="card" style={{ padding: "12px 16px", marginBottom: 14, borderColor: "#f59e0b", background: "#fffbeb", color: "#92400e", fontSize: 12 }}>数据已达到单次扫描上限，本页统计可能不是全量。节点上限 {number(overview.scan.node_limit)}，边上限 {number(overview.scan.edge_limit)}。</div> : null}
    <div className="grid grid-4" style={{ marginBottom: 16 }}><MetricCard label="连接状态" value={online ? "运行正常" : "连接失败"} color={online ? "#16a34a" : "#dc2626"} detail={`${number(connection.latency_ms)} ms`} /><MetricCard label="节点总量" value={number(totals.nodes)} color="#2563eb" detail={`架构 ${number(totals.architecture_nodes)} · 动态 ${number(totals.dynamic_nodes)}`} /><MetricCard label="关系总量" value={number(totals.edges)} color="#7c3aed" detail={`无效关系 ${number(totals.invalid_edges)}`} /><MetricCard label="项目空间" value={number(projects.length)} color="#0891b2" detail={`未归属节点 ${number(totals.unscoped_nodes)}`} /></div>
    <div className="grid grid-2" style={{ marginBottom: 16, alignItems: "stretch" }}>
      <section className="card"><div className="card-header"><div><h2>连接与 Schema</h2><p>HugeGraph 服务和当前业务标签的实时状态。</p></div></div><div className="card-body" style={{ display: "grid", gridTemplateColumns: "130px 1fr", gap: "10px 14px", fontSize: 13 }}><span style={{ color: "var(--ink-500)" }}>服务地址</span><strong>{connection.selected_base_url || `${connection.host}:${connection.port}`}</strong><span style={{ color: "var(--ink-500)" }}>图空间 / 图</span><strong>{connection.graphspace} / {connection.graph}</strong><span style={{ color: "var(--ink-500)" }}>节点标签</span><SchemaState label={connection.schema?.node_label} ready={connection.schema?.node_label_ready} /><span style={{ color: "var(--ink-500)" }}>关系标签</span><SchemaState label={connection.schema?.edge_label} ready={connection.schema?.edge_label_ready} />{connection.error ? <><span style={{ color: "var(--ink-500)" }}>异常</span><span style={{ color: "#dc2626", wordBreak: "break-word" }}>{connection.error}</span></> : null}</div></section>
      <section className="card"><div className="card-header"><div><h2>数据类型分布</h2><p>节点类型和关系类型按数量排序。</p></div></div><div className="card-body" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}><Distribution title="节点" items={overview.node_types} /><Distribution title="关系" items={overview.edge_types} /></div></section>
    </div>
    <section className="card" style={{ marginBottom: 16 }}><div className="card-header"><div><h2>项目图谱用量与维护</h2><p>导出不改变数据；清理必须先预览影响范围并完成二次文本确认。</p></div></div><div className="card-body flush graph-project-usage-table-wrap"><Table className="logscope-semi-table graph-project-usage-table" pagination={false} rowKey="id" dataSource={projects} empty={<EmptyState compact title="暂无项目" detail="当前没有可管理的项目图谱。" />} columns={[{ title: "项目", width: 230, render: (_, project) => <div className="graph-project-name-cell"><strong>{project.name}</strong><small className="table-subtitle">{project.id}</small></div> }, { title: "节点", width: 78, dataIndex: "nodes", render: number }, { title: "架构 / 动态", width: 112, render: (_, project) => `${number(project.architecture_nodes)} / ${number(project.dynamic_nodes)}` }, { title: "关系", width: 78, dataIndex: "edges", render: number }, { title: "项目状态", width: 108, dataIndex: "status", render: (value) => <Tag color={value === "active" ? "green" : "grey"}>{value}</Tag> }, { title: "安全操作", width: 350, render: (_, project) => <div className="row-actions graph-project-safe-actions"><BusyButton icon={<IconDownload />} className="button button-secondary button-small" busy={exporting === project.id} busyText="导出中…" onClick={() => exportProject(project)}>导出</BusyButton><AppButton icon={<IconClear />} className="button button-secondary button-small" onClick={() => setOperation({ action: "cleanup_batch", project })}>清理日志批次</AppButton><AppButton icon={<IconDeleteStroked />} className="button button-ghost button-small" onClick={() => setOperation({ action: "clear_project", project })} style={{ color: "#dc2626", border: "1px solid rgba(220,38,38,.25)" }}>清空项目图谱</AppButton></div> }]} /></div></section>
    <GraphExplorer projects={projects} />
    <QualityCheck projects={projects} onOperationCompleted={async () => { await load(); }} />
    <section className="card"><div className="card-header"><div><h2>管理员操作审计</h2><p>记录预览、执行人、影响范围、执行结果和失败原因。</p></div><AppButton icon={<IconRefresh />} className="button button-secondary button-small" onClick={refreshOperations}>刷新</AppButton></div><div className="card-body flush"><OperationTable items={state.operations} /></div></section>
    {operation ? <OperationModal action={operation.action} project={operation.project} onClose={() => setOperation(null)} onCompleted={async () => { setOperation(null); await load(); }} /> : null}
  </>;
}
