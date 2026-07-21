import { api } from "../api.js";
import { projectShell } from "../shell.js";
import { badge, emptyState, errorState, escapeHtml, formatConfidence, formatDate, loading } from "../ui.js";

export async function renderIncidentsPage(root, project) {
  root.innerHTML = projectShell(project, "incidents", `<div id="page-content">${loading("正在读取故障列表…")}</div>`);
  const content = root.querySelector("#page-content");
  let items = [];
  let filters = { status: "", severity: "" };
  let query = "";

  async function load() {
    try {
      items = (await api.incidents(project.id, filters)).items || [];
      paint();
    } catch (error) {
      content.innerHTML = errorState(error, "retry-incidents");
      content.querySelector("#retry-incidents")?.addEventListener("click", load);
    }
  }

  function paint() {
    const visible = items.filter((item) => {
      const haystack = `${item.title} ${item.root_candidate} ${item.fault_mode} ${item.external_incident_id}`.toLowerCase();
      return haystack.includes(query.toLowerCase());
    });
    content.innerHTML = `
      <div class="page-header"><div><h1>故障与根因</h1><p>日志证据、架构路径和处理闭环都保留在同一个故障记录中。</p></div><a class="button button-primary" href="#/projects/${project.id}/logs">＋ 分析新日志</a></div>
      <div class="toolbar">
        <div class="filters">
          <input class="input" id="incident-search" value="${escapeHtml(query)}" placeholder="搜索标题、候选或故障模式" style="min-width:260px" />
          <select class="select" id="status-filter"><option value="">全部状态</option>${option("open", "待处理", filters.status)}${option("in_progress", "处理中", filters.status)}${option("resolved", "已解决", filters.status)}${option("ignored", "已忽略", filters.status)}</select>
          <select class="select" id="severity-filter"><option value="">全部等级</option>${option("critical", "严重", filters.severity)}${option("high", "高", filters.severity)}${option("medium", "中", filters.severity)}${option("low", "低", filters.severity)}</select>
        </div>
        <span style="color:var(--ink-500)">${visible.length} 条记录</span>
      </div>
      <section class="card"><div class="card-body flush">${incidentsTable(visible, project.id)}</div></section>`;
    bind();
  }

  function bind() {
    content.querySelector("#incident-search")?.addEventListener("input", (event) => { query = event.target.value; paint(); const input = content.querySelector("#incident-search"); input?.focus(); input?.setSelectionRange(query.length, query.length); });
    content.querySelector("#status-filter")?.addEventListener("change", async (event) => { filters.status = event.target.value; content.innerHTML = loading("正在筛选…"); await load(); });
    content.querySelector("#severity-filter")?.addEventListener("change", async (event) => { filters.severity = event.target.value; content.innerHTML = loading("正在筛选…"); await load(); });
  }

  await load();
}

function option(value, label, selected) {
  return `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`;
}

function incidentsTable(items, projectId) {
  if (!items.length) return emptyState("没有匹配的故障", "调整筛选条件，或先上传日志执行异常检测。 ");
  return `<div class="table-wrap"><table class="table"><thead><tr><th>故障</th><th>根因候选</th><th>因果链</th><th>等级</th><th>状态</th><th>评分</th><th>时间</th></tr></thead><tbody>${items.map((item) => `<tr>
    <td><a class="table-title" href="#/projects/${projectId}/incidents/${item.id}">${escapeHtml(item.title)}</a><span class="table-subtitle">${escapeHtml(item.external_incident_id)} · ${escapeHtml(item.fault_mode || "未分类")}</span></td>
    <td><strong>${escapeHtml(item.root_candidate || "—")}</strong></td>
    <td><span class="table-subtitle" style="max-width:260px">${escapeHtml((item.chain || []).join(" → ") || "—")}</span></td>
    <td>${badge(item.severity, "severity")}</td><td>${badge(item.status)}</td><td><strong>${formatConfidence(item.root_confidence)}</strong></td><td>${formatDate(item.created_at)}</td>
  </tr>`).join("")}</tbody></table></div>`;
}
