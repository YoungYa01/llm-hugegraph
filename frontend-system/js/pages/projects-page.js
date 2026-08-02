import { api } from "../api.js";
import { user } from "../auth.js";
import { cacheProject } from "../state.js";
import { badge, emptyState, errorState, escapeHtml, formatDate, loading, setBusy, toast } from "../ui.js";

export async function renderProjectsPage(root, { onLogout }) {
  const account = user() || {};
  root.innerHTML = `<div class="workspace">
    <header class="topbar">
      <a class="brand" href="#/projects" style="color:var(--ink-950);padding:0"><span class="brand-mark">L</span><span>LogScope RCA</span></a>
      <div style="display:flex;align-items:center;gap:12px">
        <span style="color:var(--ink-600)">${escapeHtml(account.display_name || account.username)}</span>
        <button class="button button-secondary button-small" id="logout-button">退出</button>
      </div>
    </header>
    <main class="content">
      <div class="page-header">
        <div><h1>项目空间</h1><p>每个项目拥有独立的架构图谱、日志批次和故障处理记录。</p></div>
        <button class="button button-primary" id="create-project">＋ 新建项目</button>
      </div>
      <div id="projects-content">${loading("正在加载项目…")}</div>
    </main>
  </div>`;
  root.querySelector("#logout-button")?.addEventListener("click", onLogout);
  root.querySelector("#create-project")?.addEventListener("click", () => showProjectModal(root, load));

  async function load() {
    const content = root.querySelector("#projects-content");
    try {
      const { items } = await api.projects();
      items.forEach(cacheProject);
      if (!items.length) {
        content.innerHTML = emptyState(
          "还没有项目",
          "先创建一个项目，再导入该系统的架构描述。",
          '<button class="button button-primary" id="empty-create">创建第一个项目</button>',
        );
        content.querySelector("#empty-create")?.addEventListener("click", () => showProjectModal(root, load));
        return;
      }
      content.innerHTML = `<div class="grid grid-3">
        ${items.map((project) => `
          <div class="card project-card" style="position:relative;display:flex;flex-direction:column;justify-content:space-between">
            <div style="position:absolute;top:12px;right:12px;z-index:3">
              <button class="button button-ghost button-small project-delete-btn" data-delete-id="${project.id}" data-delete-name="${escapeHtml(project.name)}" title="删除此项目" style="color:var(--danger);padding:3px 10px;font-size:12px;background:rgba(220,38,38,0.06);border:1px solid rgba(220,38,38,0.2)">
                删除
              </button>
            </div>
            <a href="#/projects/${encodeURIComponent(project.id)}/overview" style="text-decoration:none;color:inherit;flex:1;display:flex;flex-direction:column">
              <div class="project-card-top" style="margin-bottom:12px">
                <span class="project-symbol">${escapeHtml(project.name.slice(0, 1).toUpperCase())}</span>
              </div>
              <h2 style="font-size:16px;font-weight:700;margin-bottom:6px;padding-right:90px;word-break:break-all">${escapeHtml(project.name)}</h2>
              <p style="color:var(--ink-600);font-size:13px;line-height:1.5;margin-bottom:16px;flex:1">${escapeHtml(project.description || "暂无项目描述")}</p>
              <div class="project-meta" style="border-top:1px solid var(--border);padding-top:12px;margin-top:auto">
                <span style="font-size:12px;color:var(--ink-500)">更新于 ${formatDate(project.updated_at)}</span>
                <strong style="color:var(--brand);font-size:13px">进入项目 →</strong>
              </div>
            </a>
          </div>
        `).join("")}
        <button class="card project-card new-project-card" id="card-create" style="min-height:160px">
          <span class="project-symbol">＋</span>
          <strong>新建项目</strong>
          <span class="field-hint">创建独立图谱与日志空间</span>
        </button>
      </div>`;

      content.querySelector("#card-create")?.addEventListener("click", () => showProjectModal(root, load));
      
      // 绑定删除按钮事件
      content.querySelectorAll(".project-delete-btn").forEach((button) => {
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          event.preventDefault();
          const projectId = button.dataset.deleteId;
          const projectName = button.dataset.deleteName;
          if (!projectId) return;

          const confirmed = window.confirm(
            `确定要永久删除项目“${projectName}”吗？\n\n该项目下的所有架构拓扑、日志检测批次、故障记录与 RCA 图谱节点将被一并永久清除，且无法撤销！`
          );
          if (!confirmed) return;

          setBusy(button, true, "删除中…");
          try {
            await api.deleteProject(projectId);
            toast(`项目“${projectName}”已永久删除`);
            await load();
          } catch (error) {
            toast(error.message, "error");
            setBusy(button, false);
          }
        });
      });
    } catch (error) {
      content.innerHTML = errorState(error, "retry-projects");
      content.querySelector("#retry-projects")?.addEventListener("click", load);
    }
  }
  await load();
}

function showProjectModal(root, onCreated) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <header class="modal-header"><h2 id="modal-title">创建项目</h2><button class="button button-ghost" data-close aria-label="关闭">✕</button></header>
    <div class="modal-body"><form class="form-stack" id="project-form">
      <div class="field"><label for="project-name">项目名称</label><input class="input" id="project-name" name="name" required maxlength="120" placeholder="例如：订单交易平台" autofocus /></div>
      <div class="field"><label for="project-description">项目说明</label><textarea class="textarea" id="project-description" name="description" maxlength="2000" placeholder="业务边界、部署环境或负责人等"></textarea></div>
      <div style="display:flex;justify-content:flex-end;gap:9px"><button type="button" class="button button-secondary" data-close>取消</button><button class="button button-primary" id="save-project" type="submit">创建项目</button></div>
    </form></div>
  </section>`;
  root.append(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", close));
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); });
  backdrop.querySelector("#project-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = backdrop.querySelector("#save-project");
    setBusy(button, true, "创建中…");
    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget));
      const { project } = await api.createProject(payload);
      cacheProject(project);
      close();
      toast("项目已创建");
      await onCreated();
    } catch (error) {
      toast(error.message, "error");
      setBusy(button, false);
    }
  });
}
