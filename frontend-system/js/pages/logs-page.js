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
          <form class="form-stack" id="log-form">
            <div class="field">
              <label class="file-drop" style="padding:28px 20px;text-align:center">
                <input type="file" name="file" required accept=".log,.txt,.zip,text/plain,application/zip" />
                <strong id="target-file-label" style="font-size:16px;color:var(--brand)">点击选择或拖拽日志文件 (ZIP / LOG / TXT)</strong>
                <span style="margin-top:6px;color:var(--ink-500)">Spring Boot 多服务日志建议打包为 ZIP 文件上传</span>
              </label>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:16px;flex-wrap:wrap">
              <div class="notice notice-warning" style="margin:0;flex:1;min-width:280px">
                当前采用同步分析模式。浏览器会等待算法与图谱推理完成，请勿重复点击。
              </div>
              <button class="button button-primary" id="run-analysis" type="submit" style="padding:10px 28px;font-size:14px">
                开始异常检测与 RCA
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
  }

  await load();
}



function batchesTable(items, projectId) {
  void projectId;
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
    const fileCell = `<a class="table-title" href="#/projects/${projectId}/incidents?batch=${item.id}" title="点击直达此批次故障根因">${escapeHtml(item.filename)}</a>${showTimeSub ? `<span class="table-subtitle">${formatDate(item.created_at)}</span>` : ""}${item.train_filename ? `<span class="table-subtitle">训练集：${escapeHtml(item.train_filename)}</span>` : ""}${item.error_message ? `<span class="table-subtitle" style="color:var(--danger)">${escapeHtml(item.error_message)}</span>` : ""}`;

    return `<tr>
      <td>${fileCell}</td>
      <td><span style="font-weight:600;color:var(--ink-800)">${summary.events ?? "—"}</span> <small style="color:var(--ink-500)">/ ${summary.windows ?? "—"} 窗口</small></td>
      <td>${incidentsLink}</td>
      <td><span class="table-subtitle" style="font-weight:600;color:var(--ink-700)">${durationDisplay}</span></td>
      <td>${formatDate(item.completed_at || item.created_at)}</td>
      <td><button class="button button-danger button-small" data-delete-batch="${index}">删除</button></td>
    </tr>`;
  }).join("")}</tbody></table></div>`;
}

