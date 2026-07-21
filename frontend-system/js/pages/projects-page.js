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
        ${items.map((project) => `<a class="card project-card" href="#/projects/${encodeURIComponent(project.id)}/overview">
          <div class="project-card-top"><span class="project-symbol">${escapeHtml(project.name.slice(0, 1).toUpperCase())}</span>${badge(project.status)}</div>
          <h2>${escapeHtml(project.name)}</h2>
          <p>${escapeHtml(project.description || "暂无项目描述")}</p>
          <div class="project-meta"><span>更新于 ${formatDate(project.updated_at)}</span><strong>进入项目 →</strong></div>
        </a>`).join("")}
        <button class="card project-card new-project-card" id="card-create"><span class="project-symbol">＋</span><strong>新建项目</strong><span class="field-hint">创建独立图谱与日志空间</span></button>
      </div>`;
      content.querySelector("#card-create")?.addEventListener("click", () => showProjectModal(root, load));
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
