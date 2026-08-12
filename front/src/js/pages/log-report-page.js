import { api } from "../api.js";
import { projectShell } from "../shell.js";
import { badge, emptyState, errorState, escapeHtml, formatConfidence, formatDate, loading } from "../ui.js";

export async function renderLogReportPage(root, project, batchId) {
  root.innerHTML = projectShell(project, "logs", `<div id="page-content">${loading("正在读取综合诊断报告…")}</div>`);
  const content = root.querySelector("#page-content");

  async function load() {
    try {
      const { batch, report } = await api.logReport(project.id, batchId);
      paint(batch, report || {});
    } catch (error) {
      content.innerHTML = errorState(error, "retry-log-report");
      content.querySelector("#retry-log-report")?.addEventListener("click", load);
    }
  }

  function paint(batch, report) {
    const summary = report.summary || {};
    const nodes = report.node_frequencies || [];
    const incidents = report.incidents || [];
    const topNode = summary.top_node || nodes[0] || null;

    content.innerHTML = `
      <div class="page-header" style="align-items:flex-start">
        <div>
          <a class="link" href="#/projects/${project.id}/logs" style="display:inline-flex;align-items:center;gap:4px;margin-bottom:8px;font-size:13px">← 返回日志批次</a>
          <h1 style="margin:0">综合诊断报告</h1>
          <p style="margin-top:6px">
            ${escapeHtml(batch.filename || "日志批次")}
            <span style="color:var(--ink-500)"> · ${formatDate(batch.completed_at || batch.created_at)}</span>
          </p>
        </div>
        <div class="page-actions">
          <button class="button button-secondary" id="refresh-log-report" type="button">刷新统计</button>
          <a class="button button-secondary" href="#/projects/${project.id}/incidents?batch=${encodeURIComponent(batchId)}">查看关联故障</a>
        </div>
      </div>

      <div class="grid grid-4" style="margin-bottom:18px">
        ${stat("异常段数", summary.incident_count ?? 0, "本批次挖掘出的故障窗口")}
        ${stat("根因节点", summary.root_node_count ?? 0, "作为 Top 根因的唯一节点")}
        ${stat("最高频节点", topNode?.node || "—", topNode ? `${topNode.total_hits} 次关联` : "暂无节点命中")}
        ${stat("日志规模", `${summary.event_count ?? 0} / ${summary.window_count ?? 0}`, "事件 / 窗口")}
      </div>

      <section class="card" style="margin-bottom:20px">
        <div class="card-header"><div><h2>批次概览</h2><p>自动汇总该批次的 RCA 结果、严重度分布和处理状态。</p></div></div>
        <div class="card-body">
          <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px" class="hero-grid-responsive">
            ${metricBlock("生成时间", formatDate(report.generated_at))}
            ${metricBlock("分析耗时", duration(summary.duration_seconds))}
            ${metricBlock("已解决 / 待处理", `${summary.resolved_count ?? 0} / ${summary.open_count ?? 0}`)}
          </div>
          <div style="margin-top:14px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px">
            ${severityMetric("严重", summary.severity_dist?.critical || 0, "#dc2626")}
            ${severityMetric("高", summary.severity_dist?.high || 0, "#ea580c")}
            ${severityMetric("中", summary.severity_dist?.medium || 0, "#ca8a04")}
            ${severityMetric("低", summary.severity_dist?.low || 0, "#16a34a")}
          </div>
        </div>
      </section>

      <section class="card" style="margin-bottom:20px">
        <div class="card-header"><div><h2>节点故障频次</h2><p>根因命中表示节点被判定为最可能根因；链路出现表示节点参与故障传播链。</p></div></div>
        <div class="card-body flush">${nodeTable(nodes)}</div>
      </section>

      <section class="card">
        <div class="card-header"><div><h2>关联故障明细</h2><p>保留每个异常段的根因候选、传播链和评分，便于回溯。</p></div></div>
        <div class="card-body flush">${incidentTable(incidents, project.id)}</div>
      </section>
    `;
    content.querySelector("#refresh-log-report")?.addEventListener("click", load);
  }

  await load();
}

function stat(label, value, hint) {
  return `<div class="card stat-card"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value" style="font-size:20px;line-height:1.2;word-break:break-word">${escapeHtml(String(value ?? "—"))}</div><div class="stat-hint">${escapeHtml(hint)}</div></div>`;
}

function metricBlock(label, value) {
  return `<div style="background:var(--surface-soft);border:1px solid var(--border);border-radius:8px;padding:12px"><div class="stat-label">${escapeHtml(label)}</div><div style="font-size:14px;font-weight:700;color:var(--ink-800);margin-top:4px">${escapeHtml(String(value || "—"))}</div></div>`;
}

function severityMetric(label, value, color) {
  return `<div style="border:1px solid ${color}33;background:${color}0d;border-radius:8px;padding:10px;text-align:center"><div style="font-size:12px;font-weight:700;color:${color}">${escapeHtml(label)}</div><div style="font-size:22px;font-weight:800;color:${color}">${escapeHtml(String(value))}</div></div>`;
}

function nodeTable(nodes) {
  if (!nodes.length) return emptyState("暂无节点频次", "本批次尚未形成可统计的根因节点或传播链节点。");
  return `<div class="table-wrap"><table class="table"><thead><tr><th>节点</th><th>总频次</th><th>根因命中</th><th>链路出现</th><th>关联故障数</th><th>最近出现</th></tr></thead><tbody>${nodes.map((item) => `<tr><td><strong>${escapeHtml(item.node)}</strong></td><td><span style="font-weight:800;color:var(--brand)">${escapeHtml(String(item.total_hits || 0))}</span></td><td>${escapeHtml(String(item.root_hits || 0))}</td><td>${escapeHtml(String(item.chain_hits || 0))}</td><td>${escapeHtml(String(item.incident_count || 0))}</td><td>${formatDate(item.latest_incident_at)}</td></tr>`).join("")}</tbody></table></div>`;
}

function incidentTable(items, projectId) {
  if (!items.length) return emptyState("暂无故障明细", "该批次还没有可展示的 RCA 故障记录。");
  return `<div class="table-wrap"><table class="table"><thead><tr><th>故障</th><th>根因候选</th><th>传播链</th><th>等级</th><th>状态</th><th>评分</th><th>时间</th></tr></thead><tbody>${items.map((item) => `<tr><td><a class="table-title" href="#/projects/${projectId}/incidents/${item.id}">${escapeHtml(item.title || item.external_incident_id)}</a><span class="table-subtitle">${escapeHtml(item.external_incident_id || item.id)}</span></td><td><strong>${escapeHtml(item.root_candidate || "—")}</strong></td><td><span class="table-subtitle" style="max-width:320px">${escapeHtml((item.chain || []).join(" → ") || "—")}</span></td><td>${badge(item.severity, "severity")}</td><td>${badge(item.status)}</td><td><strong>${formatConfidence(item.root_confidence)}</strong></td><td>${formatDate(item.created_at)}</td></tr>`).join("")}</tbody></table></div>`;
}

function duration(seconds) {
  if (seconds == null || seconds === "") return "—";
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "—";
  if (value >= 60) return `${Math.floor(value / 60)}分${Math.round(value % 60)}秒`;
  return `${value.toFixed(2)}秒`;
}
