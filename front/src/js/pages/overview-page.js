import { api } from "../api.js";
import { showProjectModal } from "./projects-page.js";
import { projectShell } from "../shell.js";
import { badge, emptyState, errorState, escapeHtml, formatConfidence, formatDate, loading } from "../ui.js";

export async function renderOverviewPage(root, project) {
  root.innerHTML = projectShell(project, "overview", `<div id="page-content">${loading("正在汇总项目状态…")}</div>`);
  const content = root.querySelector("#page-content");

  try {
    const [{ dashboard }, logsData] = await Promise.all([
      api.dashboard(project.id),
      api.logs(project.id),
    ]);

    const recent = dashboard.recent_incidents || [];
    const batches = logsData.items || [];

    // 绘制主结构
    content.innerHTML = `
      <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
        <div>
          <h1 style="margin:0 0 4px 0">${escapeHtml(project.name)}</h1>
          <p style="margin:0">${escapeHtml(project.description || "项目架构与日志根因分析工作台")}</p>
        </div>
        <button class="button button-secondary button-small" id="edit-overview-project-btn" style="font-size:12px;display:inline-flex;align-items:center;gap:4px;height:34px">
          ✏️ 编辑项目配置
        </button>
      </div>

      <!-- 核心 KPI 统计卡片 -->
      <div class="grid grid-4" style="margin-bottom:16px">
        ${stat("系统架构版本", dashboard.architectures, "已完成的架构导入")}
        ${stat("日志检测批次", dashboard.log_batches, "成功完成分析")}
        ${stat("待处理故障数", (dashboard.status_dist?.open || 0) + (dashboard.status_dist?.in_progress || 0), "待处理 + 处理中")}
        ${stat("故障解决率", `${dashboard.incidents ? Math.round(((dashboard.status_dist?.resolved || 0) / dashboard.incidents) * 100) : 0}%`, `累计故障 ${dashboard.incidents || 0} 起 (${dashboard.status_dist?.resolved || 0} 已闭环)`)}
      </div>

      <!-- 推荐工作流：架构、日志、根因、综合报告四步闭环 -->
      <section class="card" style="margin-bottom:20px;padding:16px 20px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <h2 style="font-size:14px;font-weight:700;margin:0;color:var(--ink-800)">推荐分析工作流</h2>
          <span style="font-size:12px;color:var(--ink-500)">四步完成根因定位、验证与综合分析</span>
        </div>
        <div style="display:grid;grid-template-columns: repeat(4, 1fr);gap:12px" class="overview-workflow-grid">
          ${horizontalStep(project.id, "01", "导入架构描述", "由大模型抽取节点与服务依赖", "architecture")}
          ${horizontalStep(project.id, "02", "日志解析检测", "滑动窗口检测日志并提取证据", "logs")}
          ${horizontalStep(project.id, "03", "验证根因与链路", "结合图谱联合推理定位根因", "incidents")}
          ${horizontalStep(project.id, "04", "生成综合报告", "汇总节点频次、传播路径与治理建议", "reports")}
        </div>
      </section>

      <!-- 合并大看板：项目故障治理态势全景 (支持全项目/指定批次下拉筛选) -->
      <section class="card" style="margin-bottom:20px">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <h2>故障治理与等级分布态势</h2>
            <p>全景呈现故障风险级别与闭环治理状态。</p>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <label for="batch-filter-select" style="font-size:12px;font-weight:700;color:var(--ink-800)">统计范围：</label>
            <select id="batch-filter-select" style="font-size:12px;padding:6px 12px;border-radius:6px;border:1.5px solid var(--brand, #2563eb);background:#ffffff;color:var(--ink-800);font-weight:600;cursor:pointer;outline:none;box-shadow:0 1px 3px rgba(37,99,235,0.12)">
              <option value="all">全项目汇总 (所有批次)</option>
              ${batches.map((b) => `<option value="${escapeHtml(b.id)}">批次：${escapeHtml(b.filename)} (${formatDate(b.created_at)})</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="card-body" id="overview-posture-container">
          <!-- 动态充填：按全项目或按选择的批次渲染 -->
        </div>
      </section>

      <!-- 主体双栏：左侧日志批次快照 + 右侧最近故障 (高度自然等高，彻底消除留白) -->
      <div class="grid grid-2">
        <!-- 左侧：日志检测批次快照 -->
        <section class="card" style="display:flex;flex-direction:column">
          <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
            <div>
              <h2>最近日志检测批次</h2>
              <p>最近解析的 Spring 日志及异常挖掘产物。</p>
            </div>
            <a class="link" href="#/projects/${project.id}/logs" style="font-size:12px">新建批次 →</a>
          </div>
          <div class="card-body flush" style="flex:1">
            ${batches.length ? `
              <div class="table-wrap"><table class="table"><tbody>
                ${batches.slice(0, 5).map((b) => `
                  <tr>
                    <td>
                      <span class="table-title">${escapeHtml(b.filename)}</span>
                      <span class="table-subtitle">${formatDate(b.created_at)}</span>
                    </td>
                    <td>
                      <span style="font-size:12px;font-weight:600">${b.summary?.events ?? "—"}</span>
                      <span class="table-subtitle">条日志</span>
                    </td>
                    <td>
                      <a href="#/projects/${project.id}/incidents?batch=${b.id}" style="font-size:12px;font-weight:700;color:var(--brand)">
                        ${b.summary?.incidents ?? 0} 段异常
                      </a>
                    </td>
                    <td><a class="button button-secondary button-small" href="#/projects/${project.id}/incidents?batch=${b.id}">查看故障</a></td>
                  </tr>
                `).join("")}
              </tbody></table></div>
            ` : emptyState("暂无日志批次", "点击上方开始上传日志进行解析检测。")}
          </div>
        </section>

        <!-- 右侧：最近高危故障 -->
        <section class="card" style="display:flex;flex-direction:column">
          <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
            <div>
              <h2>最近故障事件</h2>
              <p>优先处理未关闭的高严重度事件。</p>
            </div>
            <a class="link" href="#/projects/${project.id}/incidents" style="font-size:12px">查看全部 →</a>
          </div>
          <div class="card-body flush" style="flex:1">
            ${recent.length ? `
              <div class="table-wrap"><table class="table"><tbody>
                ${recent.slice(0, 5).map((item) => `
                  <tr>
                    <td>
                      <a class="table-title" href="#/projects/${project.id}/incidents/${item.id}">${escapeHtml(item.title)}</a>
                      <span class="table-subtitle">${formatDate(item.created_at)}</span>
                    </td>
                    <td>${badge(item.severity, "severity")}</td>
                    <td>${badge(item.status)}</td>
                  </tr>
                `).join("")}
              </tbody></table></div>
            ` : emptyState("暂无故障事件", "分析日志后，生成的故障事件会出现在这里。")}
          </div>
        </section>
      </div>`;

    // 绑定批次下拉选择切换逻辑
    const container = content.querySelector("#overview-posture-container");
    const select = content.querySelector("#batch-filter-select");

    function renderPosture(batchId) {
      let sev = { critical: 0, high: 0, medium: 0, low: 0 };
      let st = { open: 0, in_progress: 0, resolved: 0 };
      let total = 0;

      if (batchId === "all") {
        sev = dashboard.severity_dist || sev;
        st = dashboard.status_dist || st;
        total = Number(dashboard.incidents || 0);
      } else {
        const targetBatch = batches.find((b) => b.id === batchId);
        if (targetBatch) {
          sev = targetBatch.severity_dist || sev;
          total = Number(targetBatch.summary?.incidents || 0);
          const resolved = Number(targetBatch.resolved_count || 0);
          st = {
            open: Math.max(0, total - resolved),
            in_progress: 0,
            resolved: resolved,
          };
        }
      }

      const openCount = (st.open || 0) + (st.in_progress || 0);
      const resolvedPct = total > 0 ? Math.round(((st.resolved || 0) / total) * 100) : 0;

      container.innerHTML = `
        <div style="display:grid;grid-template-columns: 1fr 1fr;gap:24px" class="hero-grid-responsive">
          <!-- 左侧：故障等级分布 -->
          <div style="background:var(--surface-soft);padding:14px;border-radius:8px;border:1px solid var(--border)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
              <span style="font-size:12px;font-weight:700;color:var(--ink-800)">故障等级分布</span>
              <span style="font-size:11px;color:var(--ink-500)">共 ${total} 起故障</span>
            </div>
            <div style="display:grid;grid-template-columns: repeat(4, 1fr);gap:8px;margin-bottom:12px;text-align:center">
              <div style="background:rgba(220,38,38,0.06);border:1px solid rgba(220,38,38,0.2);padding:8px 4px;border-radius:6px">
                <span style="font-size:10px;color:#dc2626;font-weight:700;display:block">🔴 严重</span>
                <span style="font-size:18px;font-weight:800;color:#dc2626">${sev.critical || 0}</span>
              </div>
              <div style="background:rgba(249,115,22,0.06);border:1px solid rgba(249,115,22,0.2);padding:8px 4px;border-radius:6px">
                <span style="font-size:10px;color:#ea580c;font-weight:700;display:block">🟠 高</span>
                <span style="font-size:18px;font-weight:800;color:#ea580c">${sev.high || 0}</span>
              </div>
              <div style="background:rgba(234,179,8,0.06);border:1px solid rgba(234,179,8,0.2);padding:8px 4px;border-radius:6px">
                <span style="font-size:10px;color:#ca8a04;font-weight:700;display:block">🟡 中</span>
                <span style="font-size:18px;font-weight:800;color:#ca8a04">${sev.medium || 0}</span>
              </div>
              <div style="background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.2);padding:8px 4px;border-radius:6px">
                <span style="font-size:10px;color:#16a34a;font-weight:700;display:block">🟢 低</span>
                <span style="font-size:18px;font-weight:800;color:#16a34a">${sev.low || 0}</span>
              </div>
            </div>
            ${renderSeverityBar(sev, total)}
          </div>

          <!-- 右侧：故障处理与修复进度 -->
          <div style="background:var(--surface-soft);padding:14px;border-radius:8px;border:1px solid var(--border);display:flex;flex-direction:column;justify-content:space-between">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
              <span style="font-size:12px;font-weight:700;color:var(--ink-800)">故障治理进度</span>
              <span style="font-size:11px;font-weight:700;color:${resolvedPct === 100 ? '#16a34a' : '#dc2626'}">${resolvedPct}% 已解决闭环</span>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding:8px 12px;background:var(--surface);border-radius:6px">
              <div>
                <span style="font-size:11px;color:var(--ink-500);display:block">待处理</span>
                <strong style="font-size:15px;color:#dc2626">${st.open || 0}</strong>
              </div>
              <div style="border-left:1px solid var(--border);padding-left:12px">
                <span style="font-size:11px;color:var(--ink-500);display:block">处理中</span>
                <strong style="font-size:15px;color:#ea580c">${st.in_progress || 0}</strong>
              </div>
              <div style="border-left:1px solid var(--border);padding-left:12px">
                <span style="font-size:11px;color:var(--ink-500);display:block">已解决</span>
                <strong style="font-size:15px;color:#16a34a">${st.resolved || 0}</strong>
              </div>
            </div>
            <div>
              <div style="height:8px;border-radius:4px;background:var(--surface);overflow:hidden;display:flex">
                <div style="height:100%;width:${resolvedPct}%;background:#22c55e;transition:width .3s"></div>
                <div style="height:100%;width:${total > 0 ? Math.round(((st.in_progress || 0) / total) * 100) : 0}%;background:#f97316;transition:width .3s"></div>
                <div style="height:100%;width:${total > 0 ? Math.round(((st.open || 0) / total) * 100) : 0}%;background:#dc2626;transition:width .3s"></div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    renderPosture("all");
    select?.addEventListener("change", (e) => renderPosture(e.target.value));

    content.querySelector("#edit-overview-project-btn")?.addEventListener("click", () => {
      showProjectModal(root, async () => {
        const fresh = await api.project(project.id);
        renderOverviewPage(root, fresh.project);
      }, project);
    });

  } catch (error) {
    content.innerHTML = errorState(error);
  }
}

function stat(label, value, hint) {
  return `<div class="card stat-card"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(String(value ?? 0))}</div><div class="stat-hint">${escapeHtml(hint)}</div></div>`;
}

function renderSeverityBar(sev, total) {
  if (!total) return `<div style="height:6px;border-radius:3px;background:var(--surface-soft)"></div>`;
  const cPct = Math.round(((sev.critical || 0) / total) * 100);
  const hPct = Math.round(((sev.high || 0) / total) * 100);
  const mPct = Math.round(((sev.medium || 0) / total) * 100);
  const lPct = Math.round(((sev.low || 0) / total) * 100);
  return `
    <div style="height:8px;border-radius:4px;overflow:hidden;display:flex;background:var(--surface)">
      <div style="width:${cPct}%;background:#dc2626" title="严重: ${sev.critical}"></div>
      <div style="width:${hPct}%;background:#f97316" title="高: ${sev.high}"></div>
      <div style="width:${mPct}%;background:#eab308" title="中: ${sev.medium}"></div>
      <div style="width:${lPct}%;background:#22c55e" title="低: ${sev.low}"></div>
    </div>
  `;
}

function horizontalStep(id, number, title, detail, route) {
  return `
    <a href="#/projects/${id}/${route}" style="display:flex;align-items:center;gap:12px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--surface-soft);text-decoration:none;transition:border-color .2s,box-shadow .2s">
      <span style="width:34px;height:34px;border-radius:8px;font-size:13px;font-weight:800;flex-shrink:0;background:var(--brand);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 2px 4px rgba(37,99,235,0.2)">${number}</span>
      <div style="flex:1;min-width:0">
        <strong style="display:block;font-size:13px;color:var(--ink-800);margin-bottom:2px">${escapeHtml(title)}</strong>
        <span style="color:var(--ink-500);font-size:11px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(detail)}</span>
      </div>
      <span style="color:var(--ink-400);font-weight:700">→</span>
    </a>
  `;
}
