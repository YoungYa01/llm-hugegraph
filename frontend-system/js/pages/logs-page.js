import { api } from "../api.js";
import { projectShell } from "../shell.js";
import { getLogTasks, onLogTasksChanged, rememberLogTask } from "../state.js";
import { badge, emptyState, errorState, escapeHtml, formatDate, loading, setBusy, toast } from "../ui.js";

export async function renderLogsPage(root, project) {
  root.innerHTML = projectShell(project, "logs", `<div id="page-content">${loading("正在读取日志批次…")}</div>`);
  const content = root.querySelector("#page-content");
  let batches = [];
  let disposed = false;
  let refreshVersion = 0;

  const unsubscribeTasks = onLogTasksChanged((tasks) => {
    if (disposed) return;
    const projectTasks = tasks.filter((task) => task.projectId === project.id);
    updateTasksPanel(projectTasks);
    refreshBatches();
  });

  function onTaskFinished(event) {
    const task = event.detail?.task || {};
    if (task.projectId !== project.id) return;
    updateTasksPanel(getLogTasks(project.id));
    refreshBatches();
  }

  window.addEventListener("log-task:finished", onTaskFinished);
  root.__pageCleanup = () => {
    disposed = true;
    unsubscribeTasks();
    window.removeEventListener("log-task:finished", onTaskFinished);
  };

  async function load() {
    try {
      batches = (await api.logs(project.id)).items || [];
      if (disposed) return;
      paint();
    } catch (error) {
      if (disposed) return;
      content.innerHTML = errorState(error, "retry-logs");
      content.querySelector("#retry-logs")?.addEventListener("click", load);
    }
  }

  function paint() {
    const tasks = getLogTasks(project.id);
    content.innerHTML = `
      <div class="page-header"><div><h1>日志数据与异常检测</h1><p>上传日志包后会在后台持续分析；离开本页也不会中断任务。</p></div></div>
      <div id="log-tasks-region">${tasksPanel(tasks)}</div>
      <div class="split-main" style="margin-bottom:20px">
        <section class="card">
          <div class="card-header"><div><h2>新建分析批次</h2><p>支持单个 .log/.txt、日志目录 ZIP；分析进度会自动刷新。</p></div></div>
          <div class="card-body">
            <form class="form-stack" id="log-form">
              <div class="field"><label>待检测日志</label><label class="file-drop"><input type="file" name="file" required accept=".log,.txt,.zip,text/plain,application/zip" /><strong id="target-file-label">选择待分析日志或 ZIP</strong><span>Spring Boot 多服务日志建议打包为 ZIP</span></label></div>
              <div class="notice">提交后任务进入后台队列。你可以切换到概览、架构或故障页面，完成后页面状态会自动更新。</div>
              <button class="button button-primary" id="run-analysis" type="submit">开始异常检测与 RCA</button>
            </form>
          </div>
        </section>
        <aside class="card">
          <div class="card-header"><div><h2>进度说明</h2><p>后台任务按阶段更新，完成后生成故障记录和 RCA 报告。</p></div></div>
          <div class="card-body">
            <div class="progress-guide">
              ${guideStep("上传保存", "日志包落盘并创建批次")}
              ${guideStep("窗口检测", "运行滑动窗口异常检测")}
              ${guideStep("图谱融合", "写入错误链路和根因子图")}
              ${guideStep("报告入库", "保存故障记录与产物")}
            </div>
          </div>
        </aside>
      </div>
      <section class="card">
        <div class="card-header"><div><h2>日志批次</h2><p>原始输入和分析产物按项目、批次隔离保存。</p></div></div>
        <div class="card-body flush" id="log-batches-region">${batchesTable(batches, project.id)}</div>
      </section>`;
    bind();
  }

  function updateTasksPanel(tasks = getLogTasks(project.id)) {
    const region = content.querySelector("#log-tasks-region");
    if (region) region.innerHTML = tasksPanel(tasks);
  }

  async function refreshBatches() {
    const version = ++refreshVersion;
    try {
      const nextBatches = (await api.logs(project.id)).items || [];
      if (disposed || version !== refreshVersion) return;
      batches = nextBatches;
      updateBatchesTable();
    } catch {
      // Keep the last visible table while the next poll retries.
    }
  }

  function updateBatchesTable() {
    const region = content.querySelector("#log-batches-region");
    if (!region) return;
    region.innerHTML = batchesTable(batches, project.id);
    bindDeleteButtons(region);
  }

  function bind() {
    const form = content.querySelector("#log-form");
    const target = form?.querySelector('input[name="file"]');
    target?.addEventListener("change", () => {
      content.querySelector("#target-file-label").textContent = target.files?.[0]?.name || "选择待分析日志或 ZIP";
    });
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = content.querySelector("#run-analysis");
      const data = new FormData(event.currentTarget);
      if (!data.get("train_file")?.size) data.delete("train_file");
      setBusy(button, true, "正在提交后台任务…");
      try {
        const result = await api.analyzeLogs(project.id, data);
        const batch = result.batch;
        if (batch?.id) {
          rememberLogTask({
            type: "analyze",
            projectId: project.id,
            batchId: batch.id,
            filename: batch.filename,
            status: batch.status,
            summary: batch.summary || {},
          });
        }
        batches = (await api.logs(project.id)).items || [];
        if (disposed) return;
        toast("日志分析已在后台开始");
        updateTasksPanel();
        updateBatchesTable();
        setBusy(button, false);
      } catch (error) {
        toast(error.message, "error");
        setBusy(button, false);
      }
    });
    bindDeleteButtons(content);
  }

  function bindDeleteButtons(scope) {
    scope.querySelectorAll("[data-delete-batch]").forEach((button) => button.addEventListener("click", async () => {
      const batch = batches[Number(button.dataset.deleteBatch)];
      if (!batch || batch.status === "deleting") return;
      const incidentCount = Number(batch.summary?.incidents || 0);
      const message = `删除日志批次“${batch.filename}”？${incidentCount ? `\n它关联的 ${incidentCount} 个故障记录、RCA 动态图节点和分析产物也会永久删除。` : "\n原始文件和分析产物也会永久删除。"}`;
      if (!window.confirm(message)) return;
      setBusy(button, true, "启动删除…");
      try {
        const result = await api.deleteBatch(project.id, batch.id);
        const deleting = result.batch || { ...batch, status: "deleting", summary: { progress_percent: 8, progress_message: "删除任务已开始" } };
        rememberLogTask({
          type: "delete",
          projectId: project.id,
          batchId: batch.id,
          filename: batch.filename,
          status: deleting.status,
          summary: deleting.summary || {},
        });
        batches = (await api.logs(project.id)).items || [];
        if (disposed) return;
        toast("日志批次删除已在后台开始");
        updateTasksPanel();
        updateBatchesTable();
      } catch (error) {
        toast(error.message, "error");
        setBusy(button, false);
      }
    }));
  }

  await load();
}

function guideStep(title, detail) {
  return `<div class="progress-guide-step"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div>`;
}

function tasksPanel(tasks) {
  if (!tasks.length) return "";
  return `<section class="card task-progress-panel"><div class="card-header"><div><h2>后台任务</h2><p>这些任务会在页面切换后继续运行。</p></div></div><div class="card-body">${tasks.map(taskProgress).join("")}</div></section>`;
}

function taskProgress(task) {
  const summary = task.summary || task.batch?.summary || {};
  const percent = progressPercent(task.status, summary);
  const message = summary.progress_message || (task.type === "delete" ? "正在删除日志批次" : "正在分析日志批次");
  return `<div class="task-progress-item">
    <div class="task-progress-head"><div><strong>${escapeHtml(task.filename || task.batchId)}</strong><span>${escapeHtml(message)}</span></div>${badge(task.status || "processing")}</div>
    ${progressBar(percent)}
  </div>`;
}

function progressPercent(status, summary = {}) {
  if (status === "completed") return 100;
  if (status === "failed") return 100;
  const value = Number(summary.progress_percent ?? 0);
  return Math.max(6, Math.min(99, Number.isFinite(value) ? value : 12));
}

function progressBar(percent) {
  return `<div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div>`;
}

function batchesTable(items, projectId) {
  void projectId;
  if (!items.length) return emptyState("还没有日志批次", "上传 Spring 日志后，分析记录会出现在这里。");
  return `<div class="table-wrap"><table class="table"><thead><tr><th>输入文件</th><th>事件 / 窗口</th><th>故障数</th><th>检测模式</th><th>状态</th><th>进度</th><th>时间</th><th>操作</th></tr></thead><tbody>${items.map((item, index) => {
    const summary = item.summary || {};
    const busy = item.status === "processing" || item.status === "deleting";
    return `<tr><td><strong>${escapeHtml(item.filename)}</strong>${item.train_filename ? `<span class="table-subtitle">训练集：${escapeHtml(item.train_filename)}</span>` : ""}${item.error_message ? `<span class="table-subtitle" style="color:var(--danger)">${escapeHtml(item.error_message)}</span>` : ""}</td><td>${summary.events ?? "—"} / ${summary.windows ?? "—"}</td><td>${summary.incidents ?? "—"}</td><td><span class="table-subtitle">${escapeHtml(summary.detection_mode || "—")}</span></td><td>${badge(item.status)}</td><td>${busy ? progressBar(progressPercent(item.status, summary)) : `<span class="table-subtitle">${item.status === "completed" ? "100%" : "—"}</span>`}</td><td>${formatDate(item.completed_at || item.created_at)}</td><td><button class="button button-danger button-small" data-delete-batch="${index}" ${busy ? "disabled" : ""}>删除</button></td></tr>`;
  }).join("")}</tbody></table></div>`;
}
