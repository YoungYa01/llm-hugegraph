import { api } from "../api.js";
import { projectShell } from "../shell.js";
import { badge, emptyState, errorState, escapeHtml, formatDate, loading, setBusy, toast } from "../ui.js";

export async function renderLogsPage(root, project) {
  root.innerHTML = projectShell(project, "logs", `<div id="page-content">${loading("正在读取日志批次…")}</div>`);
  const content = root.querySelector("#page-content");
  let batches = [];
  let lastResult = null;

  async function load() {
    try {
      batches = (await api.logs(project.id)).items || [];
      paint();
    } catch (error) {
      content.innerHTML = errorState(error, "retry-logs");
      content.querySelector("#retry-logs")?.addEventListener("click", load);
    }
  }

  function paint() {
    content.innerHTML = `
      <div class="page-header"><div><h1>日志数据与异常检测</h1><p>上传 Spring 风格日志，由滑动窗口算法生成异常区间、日志根因证据，再与架构图谱联合推理。</p></div></div>
      <div class="split-main" style="margin-bottom:20px">
        <section class="card">
          <div class="card-header"><div><h2>新建分析批次</h2><p>支持单个 .log/.txt、日志目录 ZIP；可选正常历史日志作为模型训练集。</p></div></div>
          <div class="card-body">
            <form class="form-stack" id="log-form">
              <div class="field"><label>待检测日志</label><label class="file-drop"><input type="file" name="file" required accept=".log,.txt,.zip,text/plain,application/zip" /><strong id="target-file-label">选择待分析日志或 ZIP</strong><span>Spring Boot 多服务日志建议打包为 ZIP</span></label></div>
              <div class="field"><label>正常训练日志（可选）</label><label class="file-drop" style="min-height:95px"><input type="file" name="train_file" accept=".log,.txt,.zip,text/plain,application/zip" /><strong id="train-file-label">选择正常历史日志</strong><span>样本充足时会提升 Isolation Forest / OCSVM 的可信度</span></label></div>
              <div class="notice notice-warning">当前 MVP 采用同步分析。浏览器会等待任务完成，请不要重复点击；生产部署建议换成 Celery / Redis 队列。</div>
              <button class="button button-primary" id="run-analysis" type="submit">开始异常检测与 RCA</button>
            </form>
          </div>
        </section>
        <aside class="card">
          <div class="card-header"><div><h2>最近一次结果</h2><p>算法运行和图谱融合摘要。</p></div></div>
          <div class="card-body" id="last-result">${resultHtml(lastResult, project.id)}</div>
        </aside>
      </div>
      <section class="card">
        <div class="card-header"><div><h2>日志批次</h2><p>原始输入和分析产物按项目、批次隔离保存。</p></div></div>
        <div class="card-body flush">${batchesTable(batches, project.id)}</div>
      </section>`;
    bind();
  }

  function bind() {
    const form = content.querySelector("#log-form");
    const target = form?.querySelector('input[name="file"]');
    const train = form?.querySelector('input[name="train_file"]');
    target?.addEventListener("change", () => { content.querySelector("#target-file-label").textContent = target.files?.[0]?.name || "选择待分析日志或 ZIP"; });
    train?.addEventListener("change", () => { content.querySelector("#train-file-label").textContent = train.files?.[0]?.name || "选择正常历史日志"; });
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = content.querySelector("#run-analysis");
      const data = new FormData(event.currentTarget);
      if (!data.get("train_file")?.size) data.delete("train_file");
      setBusy(button, true, "解析、检测和图谱推理中…");
      try {
        lastResult = await api.analyzeLogs(project.id, data);
        batches = (await api.logs(project.id)).items || [];
        toast(`分析完成，形成 ${lastResult.incidents?.length || 0} 个故障事件`);
        paint();
      } catch (error) {
        toast(error.message, "error");
        setBusy(button, false);
      }
    });
    content.querySelectorAll("[data-delete-batch]").forEach((button) => button.addEventListener("click", async () => {
      const batch = batches[Number(button.dataset.deleteBatch)];
      if (!batch) return;
      const incidentCount = Number(batch.summary?.incidents || 0);
      const message = `删除日志批次“${batch.filename}”？${incidentCount ? `\n它关联的 ${incidentCount} 个故障记录、RCA 动态图节点和分析产物也会永久删除。` : "\n原始文件和分析产物也会永久删除。"}`;
      if (!window.confirm(message)) return;
      setBusy(button, true, "删除中…");
      try {
        const result = await api.deleteBatch(project.id, batch.id);
        batches = batches.filter((item) => item.id !== batch.id);
        if (lastResult?.batch?.id === batch.id) lastResult = null;
        toast(result.warnings?.length ? `批次已删除；${result.warnings.join("；")}` : "日志批次及关联故障已删除");
        paint();
      } catch (error) {
        toast(error.message, "error");
        setBusy(button, false);
      }
    }));
  }

  await load();
}

function resultHtml(result, projectId) {
  if (!result) return `<p style="color:var(--ink-500)">运行一个分析批次后，这里会显示事件、窗口、故障数量和跳转入口。</p>`;
  const summary = result.summary || {};
  return `<div class="grid grid-2" style="margin-bottom:18px">
    ${miniStat("日志事件", summary.events)}${miniStat("异常窗口", summary.anomaly_windows)}${miniStat("故障事件", summary.incidents)}${miniStat("PCA 维数", summary.pca_components)}
  </div>
  <dl class="kv-list">
    <div class="kv-row"><dt>检测模式</dt><dd>${escapeHtml(summary.detection_mode || "—")}</dd></div>
    <div class="kv-row"><dt>模型可靠</dt><dd>${summary.model_reliable ? "是" : "否（使用规则兜底）"}</dd></div>
    <div class="kv-row"><dt>图谱写入</dt><dd>${result.integration?.nodes_written || 0} 节点 / ${result.integration?.edges_written || 0} 关系</dd></div>
  </dl>
  <a class="button button-primary button-block" style="margin-top:16px" href="#/projects/${projectId}/incidents">查看故障与根因</a>`;
}

function miniStat(label, value) {
  return `<div style="padding:13px;border-radius:9px;background:var(--surface-soft)"><span class="stat-label">${escapeHtml(label)}</span><strong style="display:block;font-size:22px">${Number(value || 0)}</strong></div>`;
}

function batchesTable(items, projectId) {
  void projectId;
  if (!items.length) return emptyState("还没有日志批次", "上传 Spring 日志后，分析记录会出现在这里。 ");
  return `<div class="table-wrap"><table class="table"><thead><tr><th>输入文件</th><th>事件 / 窗口</th><th>故障数</th><th>检测模式</th><th>状态</th><th>时间</th><th>操作</th></tr></thead><tbody>${items.map((item, index) => {
    const summary = item.summary || {};
    return `<tr><td><strong>${escapeHtml(item.filename)}</strong>${item.train_filename ? `<span class="table-subtitle">训练集：${escapeHtml(item.train_filename)}</span>` : ""}${item.error_message ? `<span class="table-subtitle" style="color:var(--danger)">${escapeHtml(item.error_message)}</span>` : ""}</td><td>${summary.events ?? "—"} / ${summary.windows ?? "—"}</td><td>${summary.incidents ?? "—"}</td><td><span class="table-subtitle">${escapeHtml(summary.detection_mode || "—")}</span></td><td>${badge(item.status)}</td><td>${formatDate(item.completed_at || item.created_at)}</td><td><button class="button button-danger button-small" data-delete-batch="${index}">删除</button></td></tr>`;
  }).join("")}</tbody></table></div>`;
}
