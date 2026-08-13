import { api } from "../api.js";
import { emptyState, errorState, escapeHtml, formatDate, loading, setBusy, toast } from "../ui.js";

const number = (value) => new Intl.NumberFormat("zh-CN").format(Number(value || 0));

const actionLabel = (action) => ({
  clear_project: "清空项目图谱",
  cleanup_batch: "清理批次动态图谱",
  delete_orphan_nodes: "删除孤立节点",
}[action] || action);

const statusLabel = (status) => ({
  previewed: "待确认",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
}[status] || status);

const statusColor = (status) => ({
  previewed: "#d97706",
  running: "#2563eb",
  completed: "#16a34a",
  failed: "#dc2626",
}[status] || "#64748b");

const riskLabel = (risk) => ({ high: "高", medium: "中", low: "低" }[risk] || risk);

export async function renderGraphAdminContent(content) {
  const state = {
    overview: null,
    explorerPage: 1,
    explorerEntity: "nodes",
    explorerProject: "",
    explorerCategory: "",
    explorerQuery: "",
  };

  content.innerHTML = `
    <div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap">
      <div>
        <h1>HugeGraph 图谱管理</h1>
        <p>查看连接与 Schema 状态、数据规模和质量，并对明确目标执行可审计的安全维护。</p>
      </div>
      <button class="button button-secondary" id="graph-admin-refresh">刷新全部</button>
    </div>
    <div id="graph-admin-root">${loading("正在读取 HugeGraph 状态与数据概览…")}</div>
  `;
  content.querySelector("#graph-admin-refresh")?.addEventListener("click", () => renderGraphAdminContent(content));

  const root = content.querySelector("#graph-admin-root");
  try {
    const [{ status }, { overview }, { items: operations }] = await Promise.all([
      api.adminGraphStatus(),
      api.adminGraphOverview(),
      api.adminGraphOperations(50),
    ]);
    state.overview = overview;
    renderMain(root, status, overview, operations, state, content);
  } catch (error) {
    root.innerHTML = errorState(error, "retry-graph-admin");
    root.querySelector("#retry-graph-admin")?.addEventListener("click", () => renderGraphAdminContent(content));
  }
}

function renderMain(root, connection, overview, operations, state, content) {
  const totals = overview.totals || {};
  const online = connection.status === "ok";
  const truncated = overview.scan?.nodes_truncated || overview.scan?.edges_truncated;
  root.innerHTML = `
    ${truncated ? `<div class="card" style="padding:12px 16px;margin-bottom:14px;border-color:#f59e0b;background:#fffbeb;color:#92400e;font-size:12px">数据已达到单次扫描上限，本页统计可能不是全量。节点上限 ${number(overview.scan.node_limit)}，边上限 ${number(overview.scan.edge_limit)}。</div>` : ""}
    <div class="grid grid-4" style="margin-bottom:16px">
      ${metricCard("连接状态", online ? "运行正常" : "连接失败", online ? "#16a34a" : "#dc2626", `${number(connection.latency_ms)} ms`)}
      ${metricCard("节点总量", number(totals.nodes), "#2563eb", `架构 ${number(totals.architecture_nodes)} · 动态 ${number(totals.dynamic_nodes)}`)}
      ${metricCard("关系总量", number(totals.edges), "#7c3aed", `无效关系 ${number(totals.invalid_edges)}`)}
      ${metricCard("项目空间", number(overview.projects?.length), "#0891b2", `未归属节点 ${number(totals.unscoped_nodes)}`)}
    </div>

    <div class="grid grid-2" style="margin-bottom:16px;align-items:stretch">
      <section class="card">
        <div class="card-header"><div><h2>连接与 Schema</h2><p>HugeGraph 服务和当前业务标签的实时状态。</p></div></div>
        <div class="card-body" style="display:grid;grid-template-columns:130px 1fr;gap:10px 14px;font-size:13px">
          <span style="color:var(--ink-500)">服务地址</span><strong>${escapeHtml(connection.selected_base_url || `${connection.host}:${connection.port}`)}</strong>
          <span style="color:var(--ink-500)">图空间 / 图</span><strong>${escapeHtml(connection.graphspace)} / ${escapeHtml(connection.graph)}</strong>
          <span style="color:var(--ink-500)">节点标签</span><span>${schemaState(connection.schema?.node_label, connection.schema?.node_label_ready)}</span>
          <span style="color:var(--ink-500)">关系标签</span><span>${schemaState(connection.schema?.edge_label, connection.schema?.edge_label_ready)}</span>
          ${connection.error ? `<span style="color:var(--ink-500)">异常</span><span style="color:#dc2626;word-break:break-word">${escapeHtml(connection.error)}</span>` : ""}
        </div>
      </section>
      <section class="card">
        <div class="card-header"><div><h2>数据类型分布</h2><p>节点类型和关系类型按数量排序。</p></div></div>
        <div class="card-body" style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
          ${distribution("节点", overview.node_types)}
          ${distribution("关系", overview.edge_types)}
        </div>
      </section>
    </div>

    <section class="card" style="margin-bottom:16px">
      <div class="card-header"><div><h2>项目图谱用量与维护</h2><p>导出不改变数据；清理必须先预览影响范围并完成二次文本确认。</p></div></div>
      <div class="card-body flush"><div class="table-wrap"><table class="table">
        <thead><tr><th>项目</th><th>节点</th><th>架构 / 动态</th><th>关系</th><th>项目状态</th><th>安全操作</th></tr></thead>
        <tbody>${(overview.projects || []).map((project) => `
          <tr>
            <td><strong>${escapeHtml(project.name)}</strong><small style="display:block;color:var(--ink-400)">${escapeHtml(project.id)}</small></td>
            <td>${number(project.nodes)}</td>
            <td>${number(project.architecture_nodes)} / ${number(project.dynamic_nodes)}</td>
            <td>${number(project.edges)}</td>
            <td>${escapeHtml(project.status)}</td>
            <td><div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="button button-secondary button-small graph-export" data-project-id="${escapeHtml(project.id)}">导出</button>
              <button class="button button-secondary button-small graph-batch-clean" data-project-id="${escapeHtml(project.id)}">清理日志批次</button>
              <button class="button button-ghost button-small graph-project-clear" data-project-id="${escapeHtml(project.id)}" style="color:#dc2626;border:1px solid rgba(220,38,38,.25)">清空项目图谱</button>
            </div></td>
          </tr>`).join("") || `<tr><td colspan="6">暂无项目</td></tr>`}</tbody>
      </table></div></div>
    </section>

    <section class="card" style="margin-bottom:16px">
      <div class="card-header"><div><h2>图谱数据浏览</h2><p>按项目、类型和关键词分页查看节点或关系，当前只读。</p></div></div>
      <div class="card-body">
        <form id="graph-explorer-form" class="graph-admin-filters">
          <div class="field"><label>数据对象</label><select class="select" name="entity"><option value="nodes">节点</option><option value="edges">关系</option></select></div>
          <div class="field"><label>所属项目</label><select class="select" name="project_id"><option value="">全部项目</option>${projectOptions(overview.projects)}</select></div>
          <div class="field"><label>类型</label><input class="input" name="category" placeholder="如 Service / CALLS" /></div>
          <div class="field"><label>关键词</label><input class="input" name="q" placeholder="名称、描述、来源文件" /></div>
          <button class="button button-primary" type="submit">查询</button>
        </form>
        <div id="graph-explorer-result" style="margin-top:14px">${loading("正在加载节点数据…")}</div>
      </div>
    </section>

    <section class="card" style="margin-bottom:16px">
      <div class="card-header"><div><h2>图谱质量检查</h2><p>检查孤立节点、无效关系、重复关系和未归属项目节点；检查本身不会修改数据。</p></div></div>
      <div class="card-body">
        <div style="display:flex;gap:9px;align-items:end;flex-wrap:wrap">
          <div class="field" style="min-width:260px"><label>检查范围</label><select class="select" id="quality-project"><option value="">全局图谱</option>${projectOptions(overview.projects)}</select></div>
          <button class="button button-primary" id="run-quality-check">开始检查</button>
        </div>
        <div id="quality-result" style="margin-top:14px;color:var(--ink-500);font-size:13px">选择范围后执行质量检查。</div>
      </div>
    </section>

    <section class="card">
      <div class="card-header"><div><h2>管理员操作审计</h2><p>记录预览、执行人、影响范围、执行结果和失败原因。</p></div><button class="button button-secondary button-small" id="refresh-operation-log">刷新</button></div>
      <div class="card-body flush" id="operation-log">${operationTable(operations)}</div>
    </section>
  `;

  bindProjectActions(root, overview.projects || [], content);
  bindExplorer(root, state);
  root.querySelector("#run-quality-check")?.addEventListener("click", () => loadQuality(root, state, content));
  root.querySelector("#refresh-operation-log")?.addEventListener("click", () => loadOperations(root));
  loadExplorer(root, state);
}

function metricCard(label, value, color, detail) {
  return `<section class="card" style="padding:16px"><span style="font-size:12px;color:var(--ink-500)">${label}</span><strong style="display:block;font-size:24px;color:${color};margin:5px 0">${value}</strong><small style="color:var(--ink-500)">${detail}</small></section>`;
}

function qualityMetric(label, value, hasIssue, detail) {
  return `<div class="quality-metric"><span>${label}</span><strong style="color:${hasIssue ? "#dc2626" : "#16a34a"}">${value}</strong><small>${detail}</small></div>`;
}

function schemaState(label, ready) {
  return `<span style="color:${ready ? "#16a34a" : "#dc2626"};font-weight:600">${ready ? "✓ 已就绪" : "✕ 未发现"}</span> <code style="font-size:11px">${escapeHtml(label || "-")}</code>`;
}

function distribution(title, items = []) {
  return `<div><strong style="display:block;font-size:12px;margin-bottom:8px">${title}</strong><div style="display:flex;gap:6px;flex-wrap:wrap">${items.slice(0, 10).map((item) => `<span style="font-size:11px;padding:4px 7px;background:var(--surface-soft);border:1px solid var(--border);border-radius:5px">${escapeHtml(item.name)} <strong>${number(item.count)}</strong></span>`).join("") || '<span style="font-size:12px;color:var(--ink-400)">暂无数据</span>'}</div></div>`;
}

function projectOptions(projects = []) {
  return projects.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("");
}

function bindProjectActions(root, projects, content) {
  root.querySelectorAll(".graph-export").forEach((button) => button.addEventListener("click", async () => {
    const project = projects.find((item) => String(item.id) === button.dataset.projectId);
    if (!project) return;
    setBusy(button, true, "导出中…");
    try {
      const data = await api.adminGraphExport(project.id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${project.name}-graph.json`;
      link.click();
      URL.revokeObjectURL(url);
      toast(`项目“${project.name}”图谱已导出`);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  }));
  root.querySelectorAll(".graph-batch-clean").forEach((button) => button.addEventListener("click", () => {
    const project = projects.find((item) => String(item.id) === button.dataset.projectId);
    if (project) openOperationModal(content, "cleanup_batch", project);
  }));
  root.querySelectorAll(".graph-project-clear").forEach((button) => button.addEventListener("click", () => {
    const project = projects.find((item) => String(item.id) === button.dataset.projectId);
    if (project) openOperationModal(content, "clear_project", project);
  }));
}

function bindExplorer(root, state) {
  root.querySelector("#graph-explorer-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    state.explorerEntity = values.entity;
    state.explorerProject = values.project_id;
    state.explorerCategory = values.category.trim();
    state.explorerQuery = values.q.trim();
    state.explorerPage = 1;
    loadExplorer(root, state);
  });
}

async function loadExplorer(root, state) {
  const area = root.querySelector("#graph-explorer-result");
  if (!area) return;
  area.innerHTML = loading("正在查询图谱数据…");
  try {
    const result = await api.adminGraphData({
      entity: state.explorerEntity,
      project_id: state.explorerProject,
      category: state.explorerCategory,
      q: state.explorerQuery,
      page: state.explorerPage,
      page_size: 20,
    });
    if (!result.items.length) {
      area.innerHTML = emptyState("没有匹配数据", "调整项目、类型或关键词后重试。");
      return;
    }
    const nodes = result.entity === "nodes";
    area.innerHTML = `<div class="table-wrap graph-admin-scroll"><table class="table"><thead><tr>${nodes ? "<th>节点名称</th><th>类型 / 层级</th><th>项目</th><th>来源</th>" : "<th>起点 → 终点</th><th>关系类型</th><th>项目</th><th>有效性</th>"}</tr></thead><tbody>${result.items.map((item) => nodes ? `
      <tr><td><strong>${escapeHtml(item.name)}</strong><small style="display:block;color:var(--ink-400);max-width:360px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.description || item.internal_name)}</small></td><td>${escapeHtml(item.kind)}<small style="display:block;color:var(--ink-400)">${escapeHtml(item.layer)}</small></td><td>${escapeHtml(item.project_name)}</td><td>${escapeHtml(item.source_file || "-")}</td></tr>` : `
      <tr><td><strong>${escapeHtml(item.source)}</strong> → <strong>${escapeHtml(item.target)}</strong><small style="display:block;color:var(--ink-400)">${escapeHtml(item.description || "")}</small></td><td>${escapeHtml(item.relation)}</td><td>${escapeHtml(item.project_name)}</td><td style="color:${item.valid ? "#16a34a" : "#dc2626"}">${item.valid ? "有效" : "端点缺失"}</td></tr>`).join("")}</tbody></table></div>
      <div style="display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:12px;font-size:12px;color:var(--ink-500)">
        <span>共 ${number(result.total)} 条 · 第 ${result.page}/${result.pages} 页</span>
        <button class="button button-secondary button-small" id="explorer-prev" ${result.page <= 1 ? "disabled" : ""}>上一页</button>
        <button class="button button-secondary button-small" id="explorer-next" ${result.page >= result.pages ? "disabled" : ""}>下一页</button>
      </div>`;
    area.querySelector("#explorer-prev")?.addEventListener("click", () => { state.explorerPage -= 1; loadExplorer(root, state); });
    area.querySelector("#explorer-next")?.addEventListener("click", () => { state.explorerPage += 1; loadExplorer(root, state); });
  } catch (error) {
    area.innerHTML = errorState(error, "retry-graph-data");
    area.querySelector("#retry-graph-data")?.addEventListener("click", () => loadExplorer(root, state));
  }
}

async function loadQuality(root, state, content) {
  const area = root.querySelector("#quality-result");
  const button = root.querySelector("#run-quality-check");
  const projectId = root.querySelector("#quality-project")?.value || "";
  setBusy(button, true, "检查中…");
  area.innerHTML = loading("正在扫描节点和关系…");
  try {
    const { quality } = await api.adminGraphQuality(projectId);
    const summary = quality.summary;
    area.innerHTML = `
      <div class="quality-summary" style="margin-bottom:12px">
        ${qualityMetric("孤立节点", number(summary.orphan_nodes), summary.orphan_nodes, "无有效关系连接")}
        ${qualityMetric("无效关系", number(summary.invalid_edges), summary.invalid_edges, "起点或终点缺失")}
        ${qualityMetric("重复关系", number(summary.duplicate_edge_groups), summary.duplicate_edge_groups, "完全相同的关系")}
        ${qualityMetric("未归属节点", number(summary.unscoped_nodes), summary.unscoped_nodes, "缺少项目命名空间")}
        ${qualityMetric("跨项目关系", number(summary.cross_project_edges), summary.cross_project_edges, "关系跨越项目")}
        ${qualityMetric("失效项目归属", number(summary.unknown_project_nodes), summary.unknown_project_nodes, "项目已不存在")}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:4px 0 10px;flex-wrap:wrap">
        <span style="font-size:11px;color:var(--ink-400)">检查时间：${formatDate(quality.checked_at)} · 问题样本最多展示 ${number(quality.sample_limit)} 条</span>
        ${projectId ? `<button class="button button-ghost button-small" id="delete-selected-orphans" disabled style="color:#dc2626;border:1px solid rgba(220,38,38,.25)">删除选中孤立节点</button>` : `<span style="font-size:11px;color:#b45309">如需删除孤立节点，请先选择具体项目后重新检查</span>`}
      </div>
      ${qualityDetails(quality, Boolean(projectId))}`;

    if (projectId) {
      const orphanCheckboxes = [...area.querySelectorAll(".orphan-checkbox")];
      const deleteButton = area.querySelector("#delete-selected-orphans");
      const syncDeleteButton = () => {
        const count = orphanCheckboxes.filter((item) => item.checked).length;
        deleteButton.disabled = count === 0;
        deleteButton.textContent = count ? `删除选中孤立节点（${count}）` : "删除选中孤立节点";
      };
      orphanCheckboxes.forEach((checkbox) => checkbox.addEventListener("change", syncDeleteButton));
      area.querySelector("#select-all-orphans")?.addEventListener("change", (event) => {
        orphanCheckboxes.forEach((checkbox) => { checkbox.checked = event.target.checked; });
        syncDeleteButton();
      });
      deleteButton?.addEventListener("click", () => {
        const selectedNames = orphanCheckboxes
          .filter((item) => item.checked)
          .map((item) => quality.orphan_nodes[Number(item.dataset.orphanIndex)]?.name)
          .filter(Boolean);
        const project = (state.overview?.projects || []).find((item) => String(item.id) === projectId);
        if (project && selectedNames.length) {
          openOperationModal(content, "delete_orphan_nodes", project, selectedNames);
        }
      });
    }
  } catch (error) {
    area.innerHTML = `<span style="color:#dc2626">${escapeHtml(error.message)}</span>`;
  } finally {
    setBusy(button, false);
  }
}

function qualityDetails(quality, allowOrphanSelection) {
  const rows = [
    ...(quality.orphan_nodes || []).map((item, index) => ({
      issue: "孤立节点",
      target: item.name,
      type: item.kind,
      reason: item.likely_reason,
      suggestion: item.suggestion,
      risk: item.deletion_risk,
      orphanIndex: index,
    })),
    ...(quality.invalid_edges || []).map((item) => ({ issue: "无效关系", target: `${item.source} → ${item.target}`, type: item.relation, reason: "关系起点或终点在当前图谱中不存在", suggestion: "核对关系写入和节点清理记录" })),
    ...(quality.duplicate_edges || []).map((item) => ({ issue: "重复关系", target: `${item.source} → ${item.target}`, type: `${item.relation} × ${item.count}`, reason: "存在相同起点、终点和类型的多条关系", suggestion: "保留一条有效关系并检查重复导入来源" })),
    ...(quality.cross_project_edges || []).map((item) => ({ issue: "跨项目关系", target: `${item.source} → ${item.target}`, type: item.relation, reason: `起点属于 ${item.source_project_id}，终点属于 ${item.target_project_id}`, suggestion: "检查项目命名空间和导入数据是否串用" })),
    ...(quality.unknown_project_nodes || []).map((item) => ({ issue: "失效项目归属", target: item.name, type: item.kind, reason: `引用不存在的项目 ${item.project_id}`, suggestion: "核对项目是否已删除，再决定迁移或清理节点" })),
    ...(quality.unscoped_nodes || []).filter((item) => !(quality.orphan_nodes || []).some((orphan) => orphan.id === item.id)).map((item) => ({ issue: "未归属节点", target: item.name, type: item.kind, reason: item.likely_reason, suggestion: item.suggestion, risk: item.deletion_risk })),
  ].slice(0, 200);
  if (!rows.length) return `<div style="padding:14px;border:1px solid #bbf7d0;background:#f0fdf4;color:#166534;border-radius:8px">当前范围未发现图谱质量问题。</div>`;
  return `<div class="table-wrap graph-admin-scroll graph-quality-scroll"><table class="table"><thead><tr><th style="width:42px">${allowOrphanSelection && quality.orphan_nodes?.length ? '<input type="checkbox" id="select-all-orphans" title="全选当前孤立节点" />' : ""}</th><th>问题 / 对象</th><th>可能原因</th><th>处理建议</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${row.orphanIndex !== undefined && allowOrphanSelection ? `<input type="checkbox" class="orphan-checkbox" data-orphan-index="${row.orphanIndex}" />` : ""}</td><td><strong>${escapeHtml(row.issue)}</strong><span style="display:block;font-size:12px;margin-top:3px;word-break:break-all">${escapeHtml(row.target)}</span><small style="color:var(--ink-400)">${escapeHtml(row.type || "-")}${row.risk ? ` · 删除风险 ${escapeHtml(riskLabel(row.risk))}` : ""}</small></td><td style="min-width:260px;font-size:12px;line-height:1.5">${escapeHtml(row.reason || "-")}</td><td style="min-width:240px;font-size:12px;line-height:1.5">${escapeHtml(row.suggestion || "-")}</td></tr>`).join("")}</tbody></table></div>`;
}

function operationTable(items = []) {
  if (!items.length) return `<div style="padding:20px">${emptyState("暂无管理操作", "执行过的预览和维护结果会显示在这里。")}</div>`;
  return `<div class="table-wrap"><table class="table"><thead><tr><th>时间 / 操作人</th><th>操作</th><th>目标项目</th><th>预览影响</th><th>状态 / 结果</th></tr></thead><tbody>${items.map((item) => `
    <tr><td>${formatDate(item.created_at)}<small style="display:block;color:var(--ink-400)">${escapeHtml(item.actor_display_name || item.actor_username || item.actor_id)}</small></td><td><strong>${escapeHtml(actionLabel(item.action))}</strong><small style="display:block;color:var(--ink-400)">${escapeHtml(item.target_id || "-")}</small></td><td>${escapeHtml(item.project_name || item.preview?.project_name || "项目已删除")}</td><td>节点 ${number(item.preview?.affected_nodes)} · 关系 ${number(item.preview?.affected_edges)}</td><td><strong style="color:${statusColor(item.status)}">${escapeHtml(statusLabel(item.status))}</strong>${item.error_message ? `<small style="display:block;color:#dc2626;max-width:340px;word-break:break-word">${escapeHtml(item.error_message)}</small>` : resultText(item.result)}</td></tr>`).join("")}</tbody></table></div>`;
}

function resultText(result = {}) {
  const pairs = Object.entries(result);
  return pairs.length ? `<small style="display:block;color:var(--ink-500)">${pairs.map(([key, value]) => `${escapeHtml(key)} ${number(value)}`).join(" · ")}</small>` : "";
}

async function loadOperations(root) {
  const area = root.querySelector("#operation-log");
  if (!area) return;
  area.innerHTML = loading("正在刷新操作记录…");
  try {
    const { items } = await api.adminGraphOperations(50);
    area.innerHTML = operationTable(items);
  } catch (error) {
    area.innerHTML = `<div style="padding:16px;color:#dc2626">${escapeHtml(error.message)}</div>`;
  }
}

async function openOperationModal(content, action, project, selectedNames = []) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<section class="modal" role="dialog" aria-modal="true" style="max-width:560px"><header class="modal-header"><h2>${escapeHtml(actionLabel(action))}</h2><button class="button button-ghost" data-close>✕</button></header><div class="modal-body" id="graph-operation-body">${loading("正在准备操作范围…")}</div></section>`;
  content.append(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", close));
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); });
  const body = backdrop.querySelector("#graph-operation-body");
  try {
    let batches = [];
    if (action === "cleanup_batch") batches = (await api.adminGraphBatches(project.id)).items;
    if (action === "cleanup_batch" && !batches.length) {
      body.innerHTML = emptyState("没有可选日志批次", "该项目尚无日志分析批次。");
      return;
    }
    body.innerHTML = `
      <div style="padding:11px 13px;border-radius:7px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:12px;margin-bottom:14px">该操作会删除 HugeGraph 数据且无法撤销。第一步只生成影响预览，不会修改数据。</div>
      <div class="field"><label>目标项目</label><input class="input" value="${escapeHtml(project.name)}" disabled /></div>
      ${action === "cleanup_batch" ? `<div class="field" style="margin-top:12px"><label>目标日志批次</label><select class="select" id="operation-target">${batches.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.filename)} · ${formatDate(item.created_at)}</option>`).join("")}</select></div>` : ""}
      ${action === "delete_orphan_nodes" ? `<div style="margin-top:12px"><strong style="font-size:12px">已选择 ${number(selectedNames.length)} 个孤立节点</strong><div style="max-height:130px;overflow:auto;margin-top:7px;padding:9px;border:1px solid var(--border);border-radius:7px;background:var(--surface-soft);font-size:11px;word-break:break-all">${selectedNames.map(escapeHtml).join("、")}</div></div>` : ""}
      <div style="display:flex;justify-content:flex-end;gap:9px;margin-top:18px"><button class="button button-secondary" data-cancel>取消</button><button class="button button-primary" id="create-operation-preview">生成影响预览</button></div>`;
    body.querySelector("[data-cancel]")?.addEventListener("click", close);
    body.querySelector("#create-operation-preview")?.addEventListener("click", async () => {
      const button = body.querySelector("#create-operation-preview");
      setBusy(button, true, "扫描中…");
      try {
        const targetId = body.querySelector("#operation-target")?.value || "";
        const response = action === "delete_orphan_nodes"
          ? await api.previewDeleteOrphanNodes(project.id, selectedNames)
          : await api.previewAdminGraphOperation({ action, project_id: project.id, target_id: targetId });
        const { operation } = response;
        renderConfirmation(body, operation, close, content);
      } catch (error) {
        toast(error.message, "error");
        setBusy(button, false);
      }
    });
  } catch (error) {
    body.innerHTML = `<div style="color:#dc2626">${escapeHtml(error.message)}</div>`;
  }
}

function renderConfirmation(body, operation, close, content) {
  const preview = operation.preview || {};
  body.innerHTML = `
    <h3 style="margin:0 0 7px">确认影响范围</h3>
    <p style="font-size:13px;color:var(--ink-600)">${escapeHtml(preview.description || "")}</p>
    <div class="grid grid-2" style="margin:14px 0">${metricCard("预计删除节点", number(preview.affected_nodes), "#dc2626", "基于当前实时快照")}${metricCard("预计影响关系", number(preview.affected_edges), "#dc2626", "节点删除时一并移除")}</div>
    ${preview.node_samples?.length ? `<details style="margin-bottom:14px"><summary style="cursor:pointer;font-size:12px;font-weight:600">查看节点样本</summary><div style="font-size:11px;color:var(--ink-500);margin-top:7px;word-break:break-all">${preview.node_samples.map(escapeHtml).join("、")}</div></details>` : ""}
    <div class="field"><label>二次确认：请输入 <code>${escapeHtml(operation.confirmation_text)}</code></label><input class="input" id="operation-confirmation" autocomplete="off" placeholder="必须完全一致" /></div>
    <div style="display:flex;justify-content:flex-end;gap:9px;margin-top:18px"><button class="button button-secondary" data-cancel>取消</button><button class="button button-primary" id="execute-operation" style="background:#dc2626;border-color:#dc2626">确认并执行</button></div>`;
  body.querySelector("[data-cancel]")?.addEventListener("click", close);
  body.querySelector("#execute-operation")?.addEventListener("click", async () => {
    const button = body.querySelector("#execute-operation");
    const confirmation = body.querySelector("#operation-confirmation")?.value || "";
    if (confirmation !== operation.confirmation_text) {
      toast("二次确认文本不匹配", "error");
      return;
    }
    setBusy(button, true, "执行中…");
    try {
      await api.executeAdminGraphOperation(operation.id, confirmation);
      close();
      toast("图谱维护操作执行完成");
      await renderGraphAdminContent(content);
    } catch (error) {
      toast(error.message, "error");
      setBusy(button, false);
    }
  });
}
