import { api } from "../api.js";
import { projectShell } from "../shell.js";
import { badge, emptyState, errorState, escapeHtml, formatConfidence, formatDate, loading } from "../ui.js";

export async function renderOverviewPage(root, project) {
  root.innerHTML = projectShell(project, "overview", `<div id="page-content">${loading("正在汇总项目状态…")}</div>`);
  const content = root.querySelector("#page-content");
  try {
    const { dashboard } = await api.dashboard(project.id);
    const recent = dashboard.recent_incidents || [];
    content.innerHTML = `
      <div class="page-header"><div><h1>${escapeHtml(project.name)}</h1><p>${escapeHtml(project.description || "项目架构与日志根因分析工作台")}</p></div></div>
      <div class="grid grid-4" style="margin-bottom:20px">
        ${stat("架构版本", dashboard.architectures, "已完成的架构导入")}
        ${stat("日志批次", dashboard.log_batches, "成功完成分析")}
        ${stat("待处理故障", dashboard.open_incidents, "待处理 + 处理中")}
        ${stat("已解决", dashboard.resolved_incidents, `累计故障 ${dashboard.incidents || 0}`)}
      </div>
      <div class="grid grid-2">
        <section class="card">
          <div class="card-header"><div><h2>推荐工作流</h2><p>按顺序建立可解释的根因定位上下文。</p></div></div>
          <div class="card-body">
            ${workflow(project.id, "01", "导入架构描述", "由本地大模型抽取节点和依赖，再人工校正。", "architecture")}
            ${workflow(project.id, "02", "上传 Spring 日志", "滑动窗口检测异常并生成日志侧故障证据。", "logs")}
            ${workflow(project.id, "03", "验证根因与链路", "查看候选、评分、缺失证据并记录解决方案。", "incidents")}
          </div>
        </section>
        <section class="card">
          <div class="card-header"><div><h2>最近故障</h2><p>优先处理未关闭的高严重度事件。</p></div><a class="link" href="#/projects/${project.id}/incidents">查看全部</a></div>
          <div class="card-body flush">
            ${recent.length ? `<div class="table-wrap"><table class="table"><tbody>${recent.map((item) => `<tr>
              <td><a class="table-title" href="#/projects/${project.id}/incidents/${item.id}">${escapeHtml(item.title)}</a><span class="table-subtitle">${formatDate(item.created_at)}</span></td>
              <td>${badge(item.severity, "severity")}</td><td>${badge(item.status)}</td><td>${formatConfidence(item.root_confidence)}</td>
            </tr>`).join("")}</tbody></table></div>` : emptyState("暂无故障", "上传日志并运行分析后，故障会出现在这里。")}
          </div>
        </section>
      </div>`;
  } catch (error) {
    content.innerHTML = errorState(error);
  }
}

function stat(label, value, hint) {
  return `<div class="card stat-card"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${Number(value || 0)}</div><div class="stat-hint">${escapeHtml(hint)}</div></div>`;
}

function workflow(id, number, title, detail, route) {
  return `<a href="#/projects/${id}/${route}" style="display:grid;grid-template-columns:42px 1fr auto;gap:12px;align-items:center;padding:14px 0;border-bottom:1px solid var(--line)">
    <span class="project-symbol" style="width:36px;height:36px;font-size:11px">${number}</span><span><strong style="display:block">${escapeHtml(title)}</strong><small style="color:var(--ink-500)">${escapeHtml(detail)}</small></span><span>→</span>
  </a>`;
}
