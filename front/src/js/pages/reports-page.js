import { api } from "../api.js";
import { projectShell } from "../shell.js";
import { badge, emptyState, errorState, escapeHtml, formatDate, loading, setBusy, toast } from "../ui.js";

const REPORT_STATUS = {
  not_generated: ["尚未生成", "neutral"],
  processing: ["智能分析中", "processing"],
  completed: ["报告已生成", "completed"],
  failed: ["生成失败", "failed"],
};

export async function renderReportsPage(root, project) {
  root.innerHTML = projectShell(project, "reports", `<div id="page-content">${loading("正在读取报告生成状态…")}</div>`);
  const content = root.querySelector("#page-content");
  let batches = [];
  let pollTimer = 0;

  const stopPolling = () => {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = 0;
  };

  async function load({ quiet = false } = {}) {
    try {
      batches = (await api.logs(project.id)).items || [];
      if (!content.isConnected) return;
      paint();
      schedulePolling();
    } catch (error) {
      if (!quiet) {
        content.innerHTML = errorState(error, "retry-reports");
        content.querySelector("#retry-reports")?.addEventListener("click", () => load());
      }
    }
  }

  function schedulePolling() {
    stopPolling();
    if (!batches.some((batch) => batch.report_status === "processing")) return;
    pollTimer = window.setTimeout(() => {
      if (content.isConnected) load({ quiet: true });
    }, 1500);
  }

  function paint() {
    const analyzable = batches.filter((batch) => batch.status === "completed");
    const readyCount = analyzable.filter((batch) => batch.report_status === "completed").length;
    const processingCount = analyzable.filter((batch) => batch.report_status === "processing").length;
    content.innerHTML = `
      <div class="page-header report-center-header">
        <div>
          <h1>综合分析报告</h1>
          <p>选择已经完成根因定位的日志批次，由系统进一步汇总节点故障频次、故障模式、传播路径和治理建议。</p>
        </div>
        <a class="button button-secondary" href="#/projects/${project.id}/logs">＋ 新建日志分析</a>
      </div>

      <section class="report-generation-guide" aria-label="报告生成流程">
        <div><span>1</span><strong>完成日志 RCA</strong><small>形成根因与传播链</small></div>
        <i>→</i>
        <div><span>2</span><strong>发起智能分析</strong><small>汇总批次诊断结果</small></div>
        <i>→</i>
        <div><span>3</span><strong>查看综合报告</strong><small>后续进入可直接查看</small></div>
      </section>

      <div class="report-center-summary">
        <span>可生成批次 <b>${analyzable.length}</b></span>
        <span>分析中 <b>${processingCount}</b></span>
        <span>已生成 <b>${readyCount}</b></span>
      </div>

      <section class="card">
        <div class="card-header"><div><h2>报告批次</h2><p>报告状态会保存在数据库中，无需停留在本页面等待。</p></div></div>
        <div class="card-body flush">${reportsTable(batches, project.id)}</div>
      </section>
    `;
    bind();
  }

  function bind() {
    content.querySelectorAll("[data-generate-report]").forEach((button) => {
      button.addEventListener("click", async () => {
        const batchId = button.dataset.generateReport;
        setBusy(button, true, "正在启动…");
        try {
          const result = await api.generateLogReport(project.id, batchId);
          const batch = batches.find((item) => item.id === batchId);
          if (batch) Object.assign(batch, result.batch || {}, { report_status: result.batch?.report_status || "processing" });
          if (result.message === "report_already_generated") toast("该批次报告已经生成，可以直接查看。", "success");
          else if (result.message === "report_analysis_in_progress") toast("该批次正在进行智能分析，请稍后查看。", "info");
          else toast("已开始智能分析。您可以离开此页面，完成后可直接查看报告。", "info");
          paint();
          schedulePolling();
        } catch (error) {
          toast(error.message, "error");
          setBusy(button, false);
        }
      });
    });
  }

  await load();
}

function reportsTable(items, projectId) {
  if (!items.length) return emptyState("暂无日志批次", "请先上传日志并完成根因定位分析。", `<a class="button button-primary" href="#/projects/${projectId}/logs">开始日志分析</a>`);
  return `<div class="table-wrap"><table class="table"><thead><tr><th>日志批次</th><th>RCA 状态</th><th>报告状态</th><th>申请时间</th><th>完成时间</th><th>操作</th></tr></thead><tbody>${items.map((item) => {
    const status = item.report_status || "not_generated";
    const [label, badgeType] = REPORT_STATUS[status] || REPORT_STATUS.not_generated;
    const canGenerate = item.status === "completed" && ["not_generated", "failed"].includes(status);
    return `<tr>
      <td><strong>${escapeHtml(item.filename)}</strong><span class="table-subtitle">${formatDate(item.created_at)}</span>${item.report_error_message ? `<span class="table-subtitle" style="color:var(--danger)">${escapeHtml(item.report_error_message)}</span>` : ""}</td>
      <td>${badge(item.status)}</td>
      <td><span class="badge badge-${badgeType}">${status === "processing" ? '<i class="report-status-spinner"></i>' : ""}${escapeHtml(label)}</span></td>
      <td>${formatDate(item.report_requested_at)}</td>
      <td>${formatDate(item.report_generated_at)}</td>
      <td><div class="page-actions">
        ${canGenerate ? `<button class="button button-primary button-small" type="button" data-generate-report="${escapeHtml(item.id)}">${status === "failed" ? "重新生成" : "生成报告"}</button>` : ""}
        ${status === "processing" ? `<span class="report-processing-copy">正在汇总根因结论与传播链…</span>` : ""}
        ${status === "completed" ? `<a class="button button-secondary button-small" href="#/projects/${projectId}/reports/${encodeURIComponent(item.id)}">查看报告</a>` : ""}
        ${item.status !== "completed" ? `<span class="table-subtitle">等待 RCA 完成</span>` : ""}
      </div></td>
    </tr>`;
  }).join("")}</tbody></table></div>`;
}
