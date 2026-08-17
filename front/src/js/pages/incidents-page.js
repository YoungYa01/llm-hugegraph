import { api } from "../api.js";
import { projectShell } from "../shell.js";
import { badge, emptyState, errorState, escapeHtml, formatConfidence, formatDate, loading } from "../ui.js";

const PAGE_SIZES = [10, 20, 50];

export async function renderIncidentsPage(root, project) {
  root.innerHTML = projectShell(project, "incidents", `<div id="page-content">${loading("正在读取故障列表…")}</div>`);
  const content = root.querySelector("#page-content");
  const state = readListState();
  let items = [];
  let batches = [];
  let batchMap = {};
  let batchesLoaded = false;
  let total = 0;
  let totalPages = 1;
  let requestVersion = 0;
  let searchTimer = 0;

  async function load({ focusSearch = false } = {}) {
    const version = ++requestVersion;
    try {
      const [incidentsRes, batchesRes] = await Promise.all([
        api.incidents(project.id, state),
        batchesLoaded ? Promise.resolve({ items: batches }) : api.logs(project.id),
      ]);
      if (version !== requestVersion || !content.isConnected) return;
      items = incidentsRes.items || [];
      total = Number(incidentsRes.total || 0);
      totalPages = Number(incidentsRes.total_pages || 1);
      state.page = Number(incidentsRes.page || 1);
      state.page_size = Number(incidentsRes.page_size || state.page_size);
      batches = batchesRes.items || [];
      batchesLoaded = true;
      batchMap = Object.fromEntries(batches.map((batch) => [batch.id, batch]));
      syncListUrl(project.id, state);
      paint();
      if (focusSearch) {
        const input = content.querySelector("#incident-search");
        input?.focus();
        input?.setSelectionRange(state.q.length, state.q.length);
      }
    } catch (error) {
      if (version !== requestVersion) return;
      content.innerHTML = errorState(error, "retry-incidents");
      content.querySelector("#retry-incidents")?.addEventListener("click", () => load());
    }
  }

  function changeState(patch, { focusSearch = false } = {}) {
    window.clearTimeout(searchTimer);
    Object.assign(state, patch);
    syncListUrl(project.id, state);
    load({ focusSearch });
  }

  function paint() {
    const batchOptions = batches
      .map((batch) => `<option value="${escapeHtml(batch.id)}" ${state.batch_id === batch.id ? "selected" : ""}>${escapeHtml(batch.filename)} (${formatDate(batch.created_at)})</option>`)
      .join("");
    const selectedBatch = batchMap[state.batch_id];
    const returnPath = listPath(project.id, state);

    content.innerHTML = `
      <div class="page-header"><div><h1>故障根因定位</h1><p>日志证据、架构路径和处理闭环都保留在同一个故障记录中。</p></div><div class="page-actions">${selectedBatch ? `<a class="button button-secondary" href="#/projects/${project.id}/reports">进入综合报告中心</a>` : ""}<a class="button button-primary" href="#/projects/${project.id}/logs">＋ 分析新日志</a></div></div>
      <div class="toolbar incident-list-toolbar">
        <div class="filters">
          <input class="input" id="incident-search" value="${escapeHtml(state.q)}" placeholder="搜索标题、候选、故障模式或批次" style="min-width:240px" />
          <select class="select" id="batch-filter"><option value="">全部日志批次 (${batches.length})</option>${batchOptions}</select>
          <select class="select" id="status-filter"><option value="">全部状态</option>${option("open", "待处理", state.status)}${option("in_progress", "处理中", state.status)}${option("resolved", "已解决", state.status)}${option("ignored", "已忽略", state.status)}</select>
          <select class="select" id="severity-filter"><option value="">全部等级</option>${option("critical", "严重", state.severity)}${option("high", "高", state.severity)}${option("medium", "中", state.severity)}${option("low", "低", state.severity)}</select>
        </div>
        <span style="color:var(--ink-500)">共 ${total} 条记录</span>
      </div>
      <section class="card"><div class="card-body flush">${incidentsTable(items, project.id, batchMap, returnPath)}</div></section>
      ${pagination(state, total, totalPages)}
    `;
    bind();
  }

  function bind() {
    content.querySelector("#incident-search")?.addEventListener("input", (event) => {
      state.q = event.target.value;
      state.page = 1;
      syncListUrl(project.id, state);
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => load({ focusSearch: true }), 320);
    });
    content.querySelector("#batch-filter")?.addEventListener("change", (event) => changeState({ batch_id: event.target.value, page: 1 }));
    content.querySelector("#status-filter")?.addEventListener("change", (event) => changeState({ status: event.target.value, page: 1 }));
    content.querySelector("#severity-filter")?.addEventListener("change", (event) => changeState({ severity: event.target.value, page: 1 }));
    content.querySelector("#incident-page-size")?.addEventListener("change", (event) => changeState({ page_size: Number(event.target.value), page: 1 }));
    content.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => changeState({ page: Number(button.dataset.page) })));
    content.querySelectorAll("[data-filter-batch]").forEach((button) => button.addEventListener("click", (event) => {
      event.preventDefault();
      changeState({ batch_id: event.currentTarget.dataset.filterBatch, page: 1 });
    }));
  }

  await load();
}

function readListState() {
  const query = new URLSearchParams(window.location.hash.split("?")[1] || "");
  const requestedSize = Number(query.get("page_size") || 20);
  return {
    status: query.get("status") || "",
    severity: query.get("severity") || "",
    batch_id: query.get("batch") || query.get("batch_id") || "",
    q: query.get("q") || "",
    page: Math.max(1, Number(query.get("page") || 1) || 1),
    page_size: PAGE_SIZES.includes(requestedSize) ? requestedSize : 20,
  };
}

function listPath(projectId, state) {
  const query = new URLSearchParams();
  if (state.batch_id) query.set("batch", state.batch_id);
  if (state.status) query.set("status", state.status);
  if (state.severity) query.set("severity", state.severity);
  if (state.q) query.set("q", state.q);
  query.set("page", String(state.page));
  query.set("page_size", String(state.page_size));
  return `/projects/${encodeURIComponent(projectId)}/incidents?${query.toString()}`;
}

function syncListUrl(projectId, state) {
  const path = listPath(projectId, state);
  const prefix = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(window.history.state, "", `${prefix}#${path}`);
}

function option(value, label, selected) {
  return `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`;
}

function pagination(state, total, totalPages) {
  const start = total ? (state.page - 1) * state.page_size + 1 : 0;
  const end = Math.min(total, state.page * state.page_size);
  const pageNumbers = [];
  const from = Math.max(1, state.page - 2);
  const to = Math.min(totalPages, state.page + 2);
  for (let page = from; page <= to; page += 1) pageNumbers.push(page);
  return `<div class="incident-pagination">
    <div>显示 ${start}–${end} 条，共 ${total} 条</div>
    <div class="incident-pagination-controls">
      <label>每页 <select class="select" id="incident-page-size">${PAGE_SIZES.map((size) => `<option value="${size}" ${state.page_size === size ? "selected" : ""}>${size}</option>`).join("")}</select> 条</label>
      <button class="button button-secondary button-small" type="button" data-page="${state.page - 1}" ${state.page <= 1 ? "disabled" : ""}>上一页</button>
      ${from > 1 ? `<button class="button button-ghost button-small" type="button" data-page="1">1</button>${from > 2 ? "<span>…</span>" : ""}` : ""}
      ${pageNumbers.map((page) => `<button class="button ${page === state.page ? "button-primary" : "button-ghost"} button-small" type="button" data-page="${page}" ${page === state.page ? 'aria-current="page"' : ""}>${page}</button>`).join("")}
      ${to < totalPages ? `${to < totalPages - 1 ? "<span>…</span>" : ""}<button class="button button-ghost button-small" type="button" data-page="${totalPages}">${totalPages}</button>` : ""}
      <button class="button button-secondary button-small" type="button" data-page="${state.page + 1}" ${state.page >= totalPages ? "disabled" : ""}>下一页</button>
    </div>
  </div>`;
}

function incidentsTable(items, projectId, batchMap, returnPath) {
  if (!items.length) return emptyState("没有匹配的故障记录", "调整筛选条件，或先上传日志执行异常检测。");
  return `<div class="table-wrap"><table class="table"><thead><tr><th>故障记录</th><th>所属批次</th><th>根因候选</th><th>因果链</th><th>等级</th><th>状态</th><th>评分</th><th>时间</th></tr></thead><tbody>${items.map((item) => {
    const batchObj = batchMap[item.log_batch_id];
    const detailHref = `#/projects/${encodeURIComponent(projectId)}/incidents/${encodeURIComponent(item.id)}?return=${encodeURIComponent(returnPath)}`;
    return `<tr>
    <td><a class="table-title" href="${detailHref}">${escapeHtml(item.title)}</a><span class="table-subtitle">${escapeHtml(item.external_incident_id)} · ${escapeHtml(item.fault_mode || "未分类")}</span></td>
    <td>${batchObj ? `<span class="badge badge-subtle" data-filter-batch="${escapeHtml(batchObj.id)}" title="${escapeHtml(batchObj.filename)} (${formatDate(batchObj.created_at)}) · 点击筛选" style="cursor:pointer;font-size:12px;font-weight:600;color:var(--ink-700);user-select:none">${escapeHtml(batchObj.filename)}</span>` : `<span class="table-subtitle">—</span>`}</td>
    <td><strong>${escapeHtml(item.root_candidate || "—")}</strong></td>
    <td><span class="table-subtitle" style="max-width:240px">${escapeHtml((item.chain || []).join(" → ") || "—")}</span></td>
    <td>${badge(item.severity, "severity")}</td><td>${badge(item.status)}</td><td><strong>${formatConfidence(item.root_confidence)}</strong></td><td>${formatDate(item.created_at)}</td>
  </tr>`;
  }).join("")}</tbody></table></div>`;
}
