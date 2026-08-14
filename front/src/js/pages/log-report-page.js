import { api } from "../api.js";
import { renderReportCharts } from "../report-charts.js";
import { projectShell } from "../shell.js";
import { badge, emptyState, errorState, escapeHtml, formatConfidence, formatDate, loading } from "../ui.js";

export async function renderLogReportPage(root, project, batchId) {
  root.innerHTML = projectShell(project, "logs", `<div id="page-content">${loading("正在生成批次 RCA 综合报告…")}</div>`);
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
    const incidents = report.incidents || [];
    const nodes = report.node_frequencies || [];
    const ingestion = summary.ingestion_summary || {};

    const origStartStr = (ingestion.raw_start_time || ingestion.log_start_time || batch.log_start_time || "").replace("T", " ").substring(0, 19);
    const origEndStr = (ingestion.raw_end_time || ingestion.log_end_time || batch.log_end_time || "").replace("T", " ").substring(0, 19);
    const validStartStr = (ingestion.valid_start_time || "").replace("T", " ").substring(0, 19);
    const validEndStr = (ingestion.valid_end_time || "").replace("T", " ").substring(0, 19);
    const filteredCount = Number(ingestion.filtered_lines || 0);

    // Calculate actual analyzed time range if deduplication took place
    const validTimeLabel = (filteredCount > 0 && validStartStr) ? `${validStartStr} ~ ${validEndStr}` : "同原始时域";

    content.innerHTML = `
      <div class="batch-report-page">
        <header class="batch-report-header">
          <div>
            <a class="batch-report-back" href="#/projects/${project.id}/logs">← 返回日志批次</a>
            <div class="batch-report-kicker">BATCH RCA REPORT</div>
            <h1>综合诊断报告</h1>
            <p>汇总本批次已经完成根因分析的故障结论，定位高频故障节点、共性模式与治理优先级。</p>
          </div>
          <div class="page-actions">
            <button class="button button-secondary" id="refresh-log-report" type="button">刷新报告</button>
            <a class="button button-primary" href="#/projects/${project.id}/incidents?batch=${encodeURIComponent(batchId)}">查看关联故障</a>
          </div>
        </header>

        <section class="batch-report-meta" aria-label="报告批次信息">
          ${metaItem("日志批次", batch.filename || "日志批次")}
          ${metaItem("完成时间", formatDate(batch.completed_at || batch.created_at))}
          ${metaItem("报告生成", formatDate(report.generated_at))}
          ${metaItem("日志规模", `${summary.event_count ?? 0} 条事件 / ${summary.window_count ?? 0} 个窗口`)}
          ${metaItem("原始时域覆盖", origStartStr ? `${origStartStr} ~ ${origEndStr}` : "未解析出时间范围")}
          ${metaItem("去重后有效时域", validTimeLabel)}
          ${metaItem("历史去重提纯", ingestion.deduplication_ratio ? `${ingestion.deduplication_ratio} (剔除 ${filteredCount} 行)` : "0% (剔除 0 行)")}
          ${metaItem("有效分析日志", `${ingestion.analyzed_lines ?? summary.event_count ?? 0} 行增量 / ${ingestion.total_lines ?? 0} 行原始`)}
        </section>

        <section class="batch-report-figures" aria-label="批次关键统计">
          ${figure("RCA 故障", summary.incident_count ?? 0, "本批次形成的根因结论")}
          ${figure("根因节点", summary.root_node_count ?? 0, `传播涉及 ${summary.node_count ?? 0} 个节点`)}
          ${figure("日志历史去重", ingestion.deduplication_ratio || "0%", `自动扣除 ${filteredCount} 行 / 分析 ${ingestion.analyzed_lines ?? summary.event_count ?? 0} 行`)}
          ${figure("平均置信度", formatConfidence(summary.average_confidence), "全部 RCA 结论平均值")}
          ${figure("治理闭环", `${summary.resolved_count ?? 0} / ${summary.incident_count ?? 0}`, `${Math.round(Number(summary.resolution_rate || 0) * 100)}% 已解决`)}
        </section>

        <section class="batch-report-section batch-report-conclusion">
          ${sectionHeading("01", "本批次综合结论", "所有数量由已持久化的 RCA 结果实时统计，描述不会改变根因判定。")}
          ${filteredCount > 0 ? `
            <div class="batch-report-dedup-card">
              <strong>历史重叠日志自动过滤：</strong> 本批次原始日志共 <strong>${ingestion.total_lines || 0}</strong> 行，系统已自动拦截过滤与历史批次重叠的 <strong>${filteredCount}</strong> 行数据（去重率 <strong>${ingestion.deduplication_ratio}</strong>），实际针对 <strong>${validStartStr} ~ ${validEndStr}</strong> 范围内的 <strong>${ingestion.analyzed_lines}</strong> 行增量日志完成了精准诊断。
            </div>
          ` : ""}
          ${conclusionList(report.executive_conclusions || [])}
          <div class="batch-report-status-strip">
            ${severityChip("严重", summary.severity_dist?.critical || 0, "critical")}
            ${severityChip("高", summary.severity_dist?.high || 0, "high")}
            ${severityChip("中", summary.severity_dist?.medium || 0, "medium")}
            ${severityChip("低", summary.severity_dist?.low || 0, "low")}
            <span class="batch-report-status-divider"></span>
            ${statusChip("待处理", summary.status_dist?.open || 0)}
            ${statusChip("处理中", summary.status_dist?.in_progress || 0)}
            ${statusChip("已解决", summary.status_dist?.resolved || 0)}
            ${statusChip("已忽略", summary.status_dist?.ignored || 0)}
          </div>
        </section>

        <section class="batch-report-section">
          ${sectionHeading("02", "节点故障频次", "根因命中和传播链出现采用两个独立口径，避免把不同含义的次数简单相加。")}
          <div class="batch-report-legend"><span><i class="legend-root"></i>根因命中</span><span><i class="legend-chain"></i>传播链出现</span></div>
          <div class="report-chart report-chart-wide" id="report-node-chart"></div>
          ${nodeTable(nodes)}
        </section>

        <div class="batch-report-two-column">
          <section class="batch-report-section">
            ${sectionHeading("03", "故障模式分布", "将底层故障码归一为用户可理解的故障类型。")}
            <div class="report-chart" id="report-mode-chart"></div>
            ${faultModeList(report.fault_modes || [])}
          </section>

          <section class="batch-report-section">
            ${sectionHeading("04", "治理优先级", "优先级由影响频次、根因集中度与未闭环数量共同确定。")}
            ${recommendationList(report.governance_recommendations || [])}
          </section>
        </div>

        <section class="batch-report-section">
          ${sectionHeading("05", "重点故障节点分析", "聚焦本批次根因命中最高的节点，并给出可回溯的代表证据。")}
          ${focusNodeCards(report.focus_nodes || [], project.id)}
        </section>

        <section class="batch-report-section">
          ${sectionHeading("06", "高频故障传播路径", "按完整传播链聚合排名；点击路径可查看其代表故障。")}
          <div class="report-chart report-chart-wide" id="report-path-chart"></div>
        </section>

        <section class="batch-report-section batch-report-detail-section">
          ${sectionHeading("07", "RCA 结论审计明细", "保留每个异常窗口的根因、模式、传播路径、状态和评分，便于逐条核验。")}
          ${incidentTable(incidents, project.id)}
        </section>
      </div>
    `;

    renderReportCharts(
      {
        nodeFrequency: content.querySelector("#report-node-chart"),
        faultModes: content.querySelector("#report-mode-chart"),
        propagationPaths: content.querySelector("#report-path-chart"),
      },
      report,
      {
        onPathClick: (path) => {
          const incidentId = path.incidentIds?.[0];
          if (incidentId) window.location.hash = `#/projects/${project.id}/incidents/${incidentId}`;
        },
      },
    );
    content.querySelector("#refresh-log-report")?.addEventListener("click", load);
  }

  await load();
}

function sectionHeading(number, title, detail) {
  return `<div class="batch-report-section-heading"><span>${escapeHtml(number)}</span><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p></div></div>`;
}

function metaItem(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value || "—"))}</strong></div>`;
}

function figure(label, value, hint) {
  return `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value ?? "—"))}</strong><small>${escapeHtml(hint)}</small></article>`;
}

function conclusionList(items) {
  if (!items.length) return emptyState("暂无综合结论", "本批次尚未形成可汇总的 RCA 故障记录。");
  return `<ol class="batch-report-conclusion-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>`;
}

function severityChip(label, value, severity) {
  return `<span class="batch-report-count-chip count-${severity}"><b>${escapeHtml(String(value))}</b>${escapeHtml(label)}</span>`;
}

function statusChip(label, value) {
  return `<span class="batch-report-count-chip"><b>${escapeHtml(String(value))}</b>${escapeHtml(label)}</span>`;
}

function nodeTable(nodes) {
  if (!nodes.length) return "";
  return `<div class="batch-report-table-scroll batch-report-node-table"><table class="table"><thead><tr><th>节点</th><th>根因命中</th><th>传播链出现</th><th>关联故障</th><th>根因占比</th><th>主要模式</th><th>最近出现</th></tr></thead><tbody>${nodes.map((item) => `<tr><td><strong>${escapeHtml(item.node)}</strong></td><td><b class="report-number report-number-primary">${escapeHtml(String(item.root_hits || 0))}</b></td><td><b class="report-number">${escapeHtml(String(item.chain_hits || 0))}</b></td><td>${escapeHtml(String(item.incident_count || 0))}</td><td>${Math.round(Number(item.root_ratio || 0) * 100)}%</td><td>${escapeHtml((item.fault_modes || []).join("、") || "—")}</td><td>${formatDate(item.latest_incident_at)}</td></tr>`).join("")}</tbody></table></div>`;
}

function faultModeList(items) {
  if (!items.length) return "";
  return `<div class="batch-report-compact-list">${items.slice(0, 6).map((item) => `<div><strong>${escapeHtml(item.label)}</strong><span>主要根因：${escapeHtml(item.top_root_node || "待确认")}</span><b>${escapeHtml(String(item.count || 0))} 次</b></div>`).join("")}</div>`;
}

function recommendationList(items) {
  if (!items.length) return emptyState("暂无治理建议", "需要先形成有效的 RCA 故障结论。");
  return `<div class="batch-report-recommendations">${items.map((item) => `<article><span class="priority priority-${escapeHtml(String(item.priority || "P2").toLowerCase())}">${escapeHtml(item.priority || "P2")}</span><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p>${item.nodes?.length ? `<small>涉及节点：${escapeHtml(item.nodes.join("、"))}</small>` : ""}</div></article>`).join("")}</div>`;
}

function focusNodeCards(items, projectId) {
  if (!items.length) return emptyState("暂无重点节点", "本批次没有被判定为根因的节点。");
  return `<div class="batch-report-focus-grid">${items.map((item, index) => `<article>
    <div class="batch-report-focus-title"><span>${String(index + 1).padStart(2, "0")}</span><div><h3>${escapeHtml(item.node)}</h3><p>${escapeHtml(item.description)}</p></div></div>
    <dl><div><dt>根因命中</dt><dd>${escapeHtml(String(item.root_hits || 0))} 次</dd></div><div><dt>传播链出现</dt><dd>${escapeHtml(String(item.chain_hits || 0))} 次</dd></div><div><dt>关联故障</dt><dd>${escapeHtml(String(item.incident_count || 0))} 个</dd></div></dl>
    <div class="batch-report-focus-tags">${(item.fault_modes || []).map((mode) => `<span>${escapeHtml(mode)}</span>`).join("")}${(item.affected_nodes || []).map((node) => `<span class="affected">影响 ${escapeHtml(node)}</span>`).join("")}</div>
    ${item.representative_evidence ? `<blockquote><b>代表证据</b>${escapeHtml(item.representative_evidence)}</blockquote>` : ""}
    <div class="batch-report-incident-links">${(item.incident_ids || []).slice(0, 5).map((id) => `<a href="#/projects/${projectId}/incidents/${encodeURIComponent(id)}">查看故障 ${escapeHtml(id.slice(0, 8))}</a>`).join("")}</div>
  </article>`).join("")}</div>`;
}

function incidentTable(items, projectId) {
  if (!items.length) return emptyState("暂无故障明细", "该批次还没有可展示的 RCA 故障记录。");
  return `<div class="batch-report-table-scroll"><table class="table"><thead><tr><th>故障</th><th>根因节点</th><th>故障模式</th><th>传播路径</th><th>等级</th><th>状态</th><th>置信度</th><th>时间</th></tr></thead><tbody>${items.map((item) => `<tr><td><a class="table-title" href="#/projects/${projectId}/incidents/${item.id}">${escapeHtml(item.title || item.external_incident_id)}</a><span class="table-subtitle">${escapeHtml(item.external_incident_id || item.id)}</span></td><td><strong>${escapeHtml(item.root_candidate || "—")}</strong></td><td>${escapeHtml(item.fault_mode_label || item.fault_mode || "—")}</td><td><span class="table-subtitle report-path-cell">${escapeHtml((item.chain || []).join(" → ") || "—")}</span></td><td>${badge(item.severity, "severity")}</td><td>${badge(item.status)}</td><td><strong>${formatConfidence(item.root_confidence)}</strong></td><td>${formatDate(item.created_at)}</td></tr>`).join("")}</tbody></table></div>`;
}
