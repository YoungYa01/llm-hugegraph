import { api } from "../api.js";
import { projectShell } from "../shell.js";
import { badge, emptyState, errorState, escapeHtml, formatDate, loading, setBusy, toast } from "../ui.js";
import { taskManager } from "../taskManager.js";

const logCache = {};

export async function renderLogsPage(root, project) {
  root.innerHTML = projectShell(project, "logs", `<div id="page-content"></div>`);
  const content = root.querySelector("#page-content");
  let batches = logCache[project.id] || [];
  let lastResult = null;
  let selectedLogFile = null;

  function inPageTaskCardHtml() {
    const activeTask = taskManager.getTaskByType("logs");
    if (!activeTask) return "";
    const pct = activeTask.progress || 0;
    return `
      <div class="tech-task-card" style="background:linear-gradient(135deg, #f8fafc 0%, #edf2f7 100%);border:1px solid #cbd5e1;border-left:4px solid #2563eb;border-radius:12px;padding:18px 22px;margin-bottom:24px;box-shadow:0 10px 25px -5px rgba(37,99,235,0.1);position:relative;overflow:hidden">
        <div class="tech-task-header" style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px">
          <div class="tech-task-title-group" style="display:flex;align-items:center;gap:12px">
            <div style="width:12px;height:12px;border-radius:50%;background:#2563eb;box-shadow:0 0 10px #3b82f6;display:inline-block;flex-shrink:0"></div>
            <div>
              <div class="tech-task-title" style="font-size:15px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:8px">
                日志结构化解析与 RCA 诊断中
                <span class="tech-task-tag" style="font-size:11px;font-weight:600;color:#2563eb;background:#dbeafe;padding:2px 8px;border-radius:6px;border:1px solid rgba(37,99,235,0.2)">${escapeHtml(activeTask.filename || activeTask.task_name)}</span>
              </div>
              <div class="tech-task-subtitle" style="font-size:12px;color:#64748b;margin-top:2px">后台线程独立运行中 · 离开本页或切换操作不会中断</div>
            </div>
          </div>
          <div class="tech-task-percent-badge" style="font-family:monospace,Consolas;font-size:22px;font-weight:800;color:#2563eb">${pct}%</div>
        </div>

        <div class="tech-progress-bar-outer" style="width:100%;height:14px;background:#cbd5e1;border-radius:999px;padding:2px;overflow:hidden;margin-bottom:14px;box-shadow:inset 0 1px 3px rgba(0,0,0,0.12)">
          <div class="tech-progress-bar-inner" style="width:${pct}%;height:100%;background:linear-gradient(90deg, #3b82f6 0%, #6366f1 50%, #8b5cf6 100%);border-radius:999px;transition:width 0.4s ease;box-shadow:0 2px 10px rgba(99,102,241,0.45)"></div>
        </div>

        <div class="tech-task-footer" style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div class="tech-task-status-text" style="font-size:13px;color:#334155;font-weight:500;display:flex;align-items:center;gap:6px">
            <span>⚡</span>
            <span>${escapeHtml(activeTask.progress_message || '正在处理...')}</span>
          </div>
          <div class="tech-task-steps" style="display:flex;align-items:center;gap:6px">
            <span style="font-size:11px;padding:3px 8px;border-radius:6px;background:${pct >= 5 ? '#dbeafe' : '#f1f5f9'};color:${pct >= 5 ? '#1e40af' : '#94a3b8'};font-weight:${pct >= 5 ? '600' : '400'};border:1px solid ${pct >= 5 ? '#93c5fd' : '#e2e8f0'}">1. 结构化解析</span>
            <span style="color:#cbd5e1;font-size:11px">›</span>
            <span style="font-size:11px;padding:3px 8px;border-radius:6px;background:${pct >= 20 ? '#dbeafe' : '#f1f5f9'};color:${pct >= 20 ? '#1e40af' : '#94a3b8'};font-weight:${pct >= 20 ? '600' : '400'};border:1px solid ${pct >= 20 ? '#93c5fd' : '#e2e8f0'}">2. 滑动窗口挖掘</span>
            <span style="color:#cbd5e1;font-size:11px">›</span>
            <span style="font-size:11px;padding:3px 8px;border-radius:6px;background:${pct >= 65 ? '#dbeafe' : '#f1f5f9'};color:${pct >= 65 ? '#1e40af' : '#94a3b8'};font-weight:${pct >= 65 ? '600' : '400'};border:1px solid ${pct >= 65 ? '#93c5fd' : '#e2e8f0'}">3. 图谱 RCA 推理</span>
            <span style="color:#cbd5e1;font-size:11px">›</span>
            <span style="font-size:11px;padding:3px 8px;border-radius:6px;background:${pct >= 90 ? '#dbeafe' : '#f1f5f9'};color:${pct >= 90 ? '#1e40af' : '#94a3b8'};font-weight:${pct >= 90 ? '600' : '400'};border:1px solid ${pct >= 90 ? '#93c5fd' : '#e2e8f0'}">4. 结论落盘</span>
          </div>
        </div>
      </div>
    `;
  }

  async function refreshSilently() {
    try {
      const items = (await api.logs(project.id)).items || [];
      logCache[project.id] = items;
      const hasFileSelected = content.querySelector('input[name="file"]')?.files?.length > 0;
      if (!hasFileSelected) {
        batches = items;
        paint();
      }
    } catch (_) {}
  }

  async function load() {
    if (!logCache[project.id]) {
      content.innerHTML = loading("正在读取日志批次…");
    }
    try {
      batches = (await api.logs(project.id)).items || [];
      logCache[project.id] = batches;
      paint();
    } catch (error) {
      if (!logCache[project.id]) {
        content.innerHTML = errorState(error, "retry-logs");
        content.querySelector("#retry-logs")?.addEventListener("click", load);
      }
    }
  }

  if (logCache[project.id]) {
    paint();
    refreshSilently();
  } else {
    load();
  }

  function paint() {
    content.innerHTML = `
      <div class="page-header">
        <div>
          <h1>日志解析检测</h1>
          <p>上传 Spring 风格服务日志，由滑动窗口算法生成异常区间、日志根因证据，再与系统架构拓扑联合推理。</p>
        </div>
      </div>

      <section class="card" style="margin-bottom:24px">
        <div class="card-header">
          <div>
            <h2>新建分析批次</h2>
            <p>支持上传单个 .log / .txt 或多服务日志包 ZIP；自动执行日志解析、窗口异常挖掘与图谱 RCA 推理。</p>
          </div>
        </div>
        <div class="card-body">
          <div id="log-task-container">${inPageTaskCardHtml()}</div>
          <form class="form-stack" id="log-form">
            <div class="field">
              <div class="file-drop" style="padding:28px 20px;text-align:center;position:relative">
                <input type="file" name="file" accept=".log,.txt,.zip,text/plain,application/zip" style="position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;z-index:2" />
                <strong id="target-file-label" style="font-size:16px;color:var(--brand)">点击选择或拖拽日志文件 (ZIP / LOG / TXT)</strong>
                <span style="margin-top:6px;color:var(--ink-500)">Spring Boot 多服务日志建议打包为 ZIP 文件上传</span>
              </div>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:16px;flex-wrap:wrap">
              <div class="notice notice-info" style="margin:0;flex:1;min-width:280px">
                异步后台运行模式。已支持全流程真实进度条展示，长任务处理期间您可以随时无缝切换到其他页面。
              </div>
              <button class="button button-primary" id="run-analysis" type="submit" style="padding:10px 28px;font-size:14px" ${taskManager.hasActiveTask("logs") ? "disabled" : ""}>
                ${taskManager.hasActiveTask("logs") ? "后台分析中..." : "开始异常检测与 RCA"}
              </button>
            </div>
          </form>
        </div>
      </section>

      <section class="card">
        <div class="card-header">
          <div>
            <h2>日志批次历史</h2>
            <p>原始输入、滑动窗口解析及挖掘段落按项目、批次隔离保存。</p>
          </div>
        </div>
        <div class="card-body flush">${batchesTable(batches, project.id)}</div>
      </section>`;
    bind();
  }

  function bind() {
    const form = content.querySelector("#log-form");
    const target = form?.querySelector('input[name="file"]');
    const train = form?.querySelector('input[name="train_file"]');
    target?.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (file) {
        selectedLogFile = file;
        const label = content.querySelector("#target-file-label");
        if (label) label.textContent = file.name;
      }
    });
    train?.addEventListener("change", () => { content.querySelector("#train-file-label").textContent = train.files?.[0]?.name || "选择正常历史日志"; });
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = content.querySelector("#run-analysis");
      const file = selectedLogFile || form.querySelector('input[name="file"]')?.files?.[0];
      if (!file) {
        toast("请选择有效的日志文件 (.log / .txt / .zip)", "error");
        return;
      }
      const data = new FormData();
      data.append("file", file);
      const trainFile = train?.files?.[0];
      if (trainFile) data.append("train_file", trainFile);

      setBusy(button, true, "启动后台分析任务…");
      try {
        await api.analyzeLogs(project.id, data);
        toast("日志分析与 RCA 根因推理任务已在后台启动！您可以自由切换页面。", "info");
        selectedLogFile = null;
        await taskManager.pollNow();
        const el = content.querySelector("#log-task-container");
        if (el) el.innerHTML = inPageTaskCardHtml();
        button.disabled = true;
        button.textContent = "后台分析中...";
        setBusy(button, false);
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
      
      const tr = button.closest("tr");
      if (tr) tr.classList.add("is-deleting-row");
      setBusy(button, true, "删除中…");

      try {
        const result = await api.deleteBatch(project.id, batch.id);
        batches = batches.filter((item) => item.id !== batch.id);
        if (lastResult?.batch?.id === batch.id) lastResult = null;
        toast(result.warnings?.length ? `批次已删除；${result.warnings.join("；")}` : "日志批次及关联故障已删除");
        paint();
      } catch (error) {
        if (tr) tr.classList.remove("is-deleting-row");
        toast(error.message, "error");
        setBusy(button, false);
      }
    }));

    const onTaskUpdate = () => {
      const el = content.querySelector("#log-task-container");
      if (el) el.innerHTML = inPageTaskCardHtml();
    };
    const onTaskComplete = (e) => {
      if (e.detail?.type === "logs") {
        load();
      }
    };
    taskManager.addEventListener("task:updated", onTaskUpdate);
    taskManager.addEventListener("task:completed", onTaskComplete);
  }

  await load();
}



function batchesTable(items, projectId) {
  if (!items.length) return emptyState("还没有日志批次", "上传 Spring 日志后，分析记录会出现在这里。");

  // 统计同名文件，同名时需要在文件名下显示上传时间加以区分
  const nameCounts = {};
  items.forEach((item) => { nameCounts[item.filename] = (nameCounts[item.filename] || 0) + 1; });

  return `<div class="table-wrap"><table class="table"><thead><tr><th>输入文件</th><th>事件 / 窗口数</th><th>挖掘异常段数</th><th>分析时长</th><th>解析完成时间</th><th>操作</th></tr></thead><tbody>${items.map((item, index) => {
    const summary = item.summary || {};
    const durationSec = summary.duration_seconds || item.duration_seconds;
    let durationDisplay = "—";
    if (durationSec != null) {
      const s = Number(durationSec);
      if (s >= 60) {
        const m = Math.floor(s / 60);
        const remS = Math.round(s % 60);
        durationDisplay = `${m}分 ${remS}秒`;
      } else {
        durationDisplay = `${s.toFixed(2)}s`;
      }
    }
    const incidentCnt = summary.incidents;
    const incidentsLink = incidentCnt != null ? `<a href="#/projects/${projectId}/incidents?batch=${item.id}" title="查看此批次挖掘到的异常事件" style="font-weight:700;color:var(--brand);font-size:13px">${incidentCnt} 段</a>` : "—";

    // 同名文件加时间副标题
    const showTimeSub = nameCounts[item.filename] > 1;
    const fileCell = `<span class="table-title">${escapeHtml(item.filename)}</span>${showTimeSub ? `<span class="table-subtitle">${formatDate(item.created_at)}</span>` : ""}${item.train_filename ? `<span class="table-subtitle">训练集：${escapeHtml(item.train_filename)}</span>` : ""}${item.error_message ? `<span class="table-subtitle" style="color:var(--danger)">${escapeHtml(item.error_message)}</span>` : ""}`;

    return `<tr>
      <td>${fileCell}</td>
      <td><span style="font-weight:600;color:var(--ink-800)">${summary.events ?? "—"}</span> <small style="color:var(--ink-500)">/ ${summary.windows ?? "—"} 窗口</small></td>
      <td>${incidentsLink}</td>
      <td><span class="table-subtitle" style="font-weight:600;color:var(--ink-700)">${durationDisplay}</span></td>
      <td>${formatDate(item.completed_at || item.created_at)}</td>
      <td><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <button class="button button-danger button-small" data-delete-batch="${index}">删除</button>
      </div></td>
    </tr>`;
  }).join("")}</tbody></table></div>`;
}

