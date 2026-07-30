import { api } from "../api.js";
import { user } from "../auth.js";
import { cacheProject, forgetProject } from "../state.js";
import { badge, emptyState, errorState, escapeHtml, formatDate, loading, setBusy, toast } from "../ui.js";

let includeArchived = false;

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
        <div class="page-actions">
          <label class="toggle-inline"><input type="checkbox" id="include-archived" ${includeArchived ? "checked" : ""} />显示归档</label>
          <button class="button button-primary" id="create-project">新建项目</button>
        </div>
      </div>
      <div id="projects-content">${loading("正在加载项目…")}</div>
    </main>
  </div>`;
  root.querySelector("#logout-button")?.addEventListener("click", onLogout);
  root.querySelector("#create-project")?.addEventListener("click", () => showProjectModal(root, { onSaved: load }));
  root.querySelector("#include-archived")?.addEventListener("change", async (event) => {
    includeArchived = event.currentTarget.checked;
    await load();
  });

  async function load() {
    const content = root.querySelector("#projects-content");
    content.innerHTML = loading("正在加载项目…");
    try {
      const { items } = await api.projects(includeArchived);
      items.forEach(cacheProject);
      if (!items.length) {
        content.innerHTML = emptyState(
          includeArchived ? "没有可显示的项目" : "还没有项目",
          includeArchived ? "当前账号下没有项目记录。" : "先创建一个项目，再导入该系统的架构描述。",
          '<button class="button button-primary" id="empty-create">创建第一个项目</button>',
        );
        content.querySelector("#empty-create")?.addEventListener("click", () => showProjectModal(root, { onSaved: load }));
        return;
      }
      content.innerHTML = `<div class="grid grid-3">
        ${items.map(projectCard).join("")}
        <button class="card project-card new-project-card" id="card-create"><span class="project-symbol">+</span><strong>新建项目</strong><span class="field-hint">创建独立图谱与日志空间</span></button>
      </div>`;
      content.querySelector("#card-create")?.addEventListener("click", () => showProjectModal(root, { onSaved: load }));
      content.querySelectorAll("[data-enter-project]").forEach((button) => button.addEventListener("click", () => {
        location.hash = `/projects/${encodeURIComponent(button.dataset.enterProject)}/overview`;
      }));
      content.querySelectorAll("[data-edit-project]").forEach((button) => button.addEventListener("click", () => {
        const project = items[Number(button.dataset.editProject)];
        if (project) showProjectModal(root, { project, onSaved: load });
      }));
      content.querySelectorAll("[data-archive-project]").forEach((button) => button.addEventListener("click", async () => {
        const project = items[Number(button.dataset.archiveProject)];
        if (!project) return;
        const label = project.status === "archived" ? "恢复" : "归档";
        if (!window.confirm(`${label}项目“${project.name}”？`)) return;
        setBusy(button, true, `${label}中…`);
        try {
          if (project.status === "archived") {
            const { project: saved } = await api.updateProject(project.id, {
              name: project.name,
              description: project.description || "",
              status: "active",
            });
            cacheProject(saved);
            toast("项目已恢复");
          } else {
            await api.archiveProject(project.id);
            forgetProject(project.id);
            toast("项目已归档");
          }
          await load();
        } catch (error) {
          toast(error.message, "error");
          setBusy(button, false);
        }
      }));
    } catch (error) {
      content.innerHTML = errorState(error, "retry-projects");
      content.querySelector("#retry-projects")?.addEventListener("click", load);
    }
  }
  await load();
}

function projectCard(project, index) {
  const archived = project.status === "archived";
  return `<article class="card project-card project-card-manage ${archived ? "project-card-archived" : ""}">
    <div class="project-card-top"><span class="project-symbol">${escapeHtml(project.name.slice(0, 1).toUpperCase())}</span>${badge(project.status)}</div>
    <h2>${escapeHtml(project.name)}</h2>
    <p>${escapeHtml(project.description || "暂无项目描述")}</p>
    <div class="project-meta"><span>更新于 ${formatDate(project.updated_at)}</span></div>
    <div class="project-actions">
      <button class="button button-primary button-small" data-enter-project="${escapeHtml(project.id)}" ${archived ? "disabled" : ""}>进入</button>
      <button class="button button-secondary button-small" data-edit-project="${index}">编辑</button>
      <button class="button ${archived ? "button-secondary" : "button-danger"} button-small" data-archive-project="${index}">${archived ? "恢复" : "归档"}</button>
    </div>
  </article>`;
}

function showProjectModal(root, { project = null, onSaved }) {
  const editing = Boolean(project);
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <header class="modal-header"><h2 id="modal-title">${editing ? "编辑项目" : "创建项目"}</h2><button class="button button-ghost" data-close aria-label="关闭">×</button></header>
    <div class="modal-body"><form class="form-stack" id="project-form">
      <div class="field"><label for="project-name">项目名称</label><input class="input" id="project-name" name="name" required maxlength="120" value="${escapeHtml(project?.name || "")}" placeholder="例如：订单交易平台" autofocus /></div>
      <div class="field"><label for="project-description">项目说明</label><textarea class="textarea" id="project-description" name="description" maxlength="2000" placeholder="业务边界、部署环境或负责人等">${escapeHtml(project?.description || "")}</textarea></div>
      ${editing ? `<div class="field"><label for="project-status">项目状态</label><select class="select" id="project-status" name="status">${statusOption("active", "运行中", project.status)}${statusOption("paused", "暂停", project.status)}${statusOption("archived", "归档", project.status)}</select></div>` : ""}
      <div style="display:flex;justify-content:flex-end;gap:9px"><button type="button" class="button button-secondary" data-close>取消</button><button class="button button-primary" id="save-project" type="submit">${editing ? "保存项目" : "创建项目"}</button></div>
    </form></div>
  </section>`;
  root.append(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", close));
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); });
  backdrop.querySelector("#project-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = backdrop.querySelector("#save-project");
    setBusy(button, true, editing ? "保存中…" : "创建中…");
    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget));
      const { project: saved } = editing
        ? await api.updateProject(project.id, payload)
        : await api.createProject(payload);
      cacheProject(saved);
      close();
      toast(editing ? "项目已更新" : "项目已创建");
      await onSaved();
    } catch (error) {
      toast(error.message, "error");
      setBusy(button, false);
    }
  });
}

function statusOption(value, label, current) {
  return `<option value="${value}" ${value === current ? "selected" : ""}>${label}</option>`;
}
