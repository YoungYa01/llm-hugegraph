import { api } from "../api.js";
import { projectShell } from "../shell.js";
import { badge, emptyState, errorState, escapeHtml, formatConfidence, formatDate, loading } from "../ui.js";

export async function renderIncidentsPage(root, project) {
  root.innerHTML = projectShell(project, "incidents", `<div id="page-content">${loading("正在读取故障列表…")}</div>`);
  const content = root.querySelector("#page-content");
  let items = [];
  let batches = [];
  let batchMap = {};
  
  // 从 URL query 提取初始 batch_id 参数
  const hashQuery = window.location.hash.split("?")[1] || "";
  const params = new URLSearchParams(hashQuery);
  const initialBatch = params.get("batch") || params.get("batch_id") || "";

  let filters = { status: "", severity: "", batch_id: initialBatch };
  let query = "";

  async function load() {
    try {
      const [incidentsRes, batchesRes] = await Promise.all([
        api.incidents(project.id, filters),
        api.logs(project.id),
      ]);
      items = incidentsRes.items || [];
      batches = batchesRes.items || [];
      batchMap = {};
      batches.forEach((b) => { batchMap[b.id] = b; });

      // 如果有 batch_id 过滤条件，进一步在前端做精确过滤
      paint();
    } catch (error) {
      content.innerHTML = errorState(error, "retry-incidents");
      content.querySelector("#retry-incidents")?.addEventListener("click", load);
    }
  }

  function paint() {
    let filteredItems = items;
    if (filters.batch_id) {
      filteredItems = filteredItems.filter((item) => item.log_batch_id === filters.batch_id);
    }
    const visible = filteredItems.filter((item) => {
      const batchName = batchMap[item.log_batch_id]?.filename || "";
      const haystack = `${item.title} ${item.root_candidate} ${item.fault_mode} ${item.external_incident_id} ${batchName}`.toLowerCase();
      return haystack.includes(query.toLowerCase());
    });

    const batchOptions = batches
      .map((b) => `<option value="${escapeHtml(b.id)}" ${filters.batch_id === b.id ? "selected" : ""}>${escapeHtml(b.filename)} (${formatDate(b.created_at)})</option>`)
      .join("");
    const selectedBatch = batchMap[filters.batch_id];

    content.innerHTML = `
      <div class="page-header"><div><h1>故障根因定位</h1><p>日志证据、架构路径和处理闭环都保留在同一个故障记录中。</p></div><div class="page-actions">${selectedBatch ? `<a class="button button-secondary" href="#/projects/${project.id}/logs/${selectedBatch.id}">查看当前批次综合报告</a>` : ""}<a class="button button-primary" href="#/projects/${project.id}/logs">＋ 分析新日志</a></div></div>
      <div class="toolbar">
        <div class="filters">
          <input class="input" id="incident-search" value="${escapeHtml(query)}" placeholder="搜索标题、候选或故障模式" style="min-width:240px" />
          <select class="select" id="batch-filter"><option value="">全部日志批次 (${batches.length})</option>${batchOptions}</select>
          <select class="select" id="status-filter"><option value="">全部状态</option>${option("open", "待处理", filters.status)}${option("in_progress", "处理中", filters.status)}${option("resolved", "已解决", filters.status)}${option("ignored", "已忽略", filters.status)}</select>
          <select class="select" id="severity-filter"><option value="">全部等级</option>${option("critical", "严重", filters.severity)}${option("high", "高", filters.severity)}${option("medium", "中", filters.severity)}${option("low", "低", filters.severity)}</select>
        </div>
        <span style="color:var(--ink-500)">${visible.length} 条记录</span>
      </div>
      <section class="card"><div class="card-body flush">${incidentsTable(visible, project.id, batchMap)}</div></section>`;
    bind();
  }

  function bind() {
    content.querySelector("#incident-search")?.addEventListener("input", (event) => {
      query = event.target.value;
      paint();
      const input = content.querySelector("#incident-search");
      input?.focus();
      input?.setSelectionRange(query.length, query.length);
    });
    content.querySelector("#batch-filter")?.addEventListener("change", (event) => {
      filters.batch_id = event.target.value;
      paint();
    });
    content.querySelector("#status-filter")?.addEventListener("change", async (event) => {
      filters.status = event.target.value;
      content.innerHTML = loading("正在筛选…");
      await load();
    });
    content.querySelector("#severity-filter")?.addEventListener("change", async (event) => {
      filters.severity = event.target.value;
      content.innerHTML = loading("正在筛选…");
      await load();
    });
    content.querySelectorAll("[data-filter-batch]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        filters.batch_id = e.currentTarget.dataset.filterBatch;
        paint();
      });
    });
  }

  await load();
}

function option(value, label, selected) {
  return `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`;
}

function incidentsTable(items, projectId, batchMap) {
  if (!items.length) return emptyState("没有匹配的故障记录", "调整筛选条件，或先上传日志执行异常检测。");
  return `<div class="table-wrap"><table class="table"><thead><tr><th>故障记录</th><th>所属批次</th><th>根因候选</th><th>因果链</th><th>等级</th><th>状态</th><th>评分</th><th>时间</th></tr></thead><tbody>${items.map((item) => {
    const batchObj = batchMap[item.log_batch_id];
    return `<tr>
    <td><a class="table-title" href="#/projects/${projectId}/incidents/${item.id}">${escapeHtml(item.title)}</a><span class="table-subtitle">${escapeHtml(item.external_incident_id)} · ${escapeHtml(item.fault_mode || "未分类")}</span></td>
    <td>${batchObj ? `<span class="badge badge-subtle" data-filter-batch="${escapeHtml(batchObj.id)}" title="${escapeHtml(batchObj.filename)} (${formatDate(batchObj.created_at)}) · 点击筛选" style="cursor:pointer;font-size:12px;font-weight:600;color:var(--ink-700);user-select:none">${escapeHtml(batchObj.filename)}</span>` : `<span class="table-subtitle">—</span>`}</td>
    <td><strong>${escapeHtml(item.root_candidate || "—")}</strong></td>
    <td><span class="table-subtitle" style="max-width:240px">${escapeHtml((item.chain || []).join(" → ") || "—")}</span></td>
    <td>${badge(item.severity, "severity")}</td><td>${badge(item.status)}</td><td><strong>${formatConfidence(item.root_confidence)}</strong></td><td>${formatDate(item.created_at)}</td>
  </tr>`;
  }).join("")}</tbody></table></div>`;
}
