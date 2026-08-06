import { api } from "../api.js";
import { setUser, user } from "../auth.js";
import { cacheProject } from "../state.js";
import { badge, emptyState, errorState, escapeHtml, formatDate, loading, setBusy, toast } from "../ui.js";

const SVG = {
  projects: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>`,
  database: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>`,
  users: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 1 0 7.75"></path></svg>`,
  gear: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  pencil: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
};

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export async function renderProjectsPage(root, { onLogout }) {
  const account = user() || {};
  const isAdmin = account.role === "admin";
  const initial = (account.display_name || account.username || "U").slice(0, 1).toUpperCase();
  let currentTab = "projects"; // "projects" | "log_db" | "users"
  let logDbState = { page: 1, limit: 15, project_id: "", status: "", has_fault: "", search: "" };

  function renderShell() {
    root.innerHTML = `
      <div class="app-shell" id="app-shell">
        <aside class="sidebar">
          <a class="brand" href="#/projects" style="margin-bottom:18px;text-decoration:none">
            <span class="brand-mark">L</span>
            <span>LogScope RCA <small class="brand-version">v2.0</small></span>
          </a>

          <div style="padding:10px 12px;margin-bottom:16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px">
            <small style="display:block;font-size:11px;color:rgba(255,255,255,0.5)">控制台与项目空间</small>
            <strong style="font-size:13px;color:#ffffff;display:flex;align-items:center;gap:6px;margin-top:2px">
              数据管理中心
              <span style="font-size:10px;padding:1px 6px;border-radius:4px;background:${isAdmin ? '#2563eb' : 'rgba(255,255,255,0.15)'};color:#fff;font-weight:600">
                ${isAdmin ? '管理员' : '普通用户'}
              </span>
            </strong>
          </div>

          <nav class="nav">
            <a class="nav-link ${currentTab === "projects" ? "active" : ""}" id="tab-projects-btn" href="javascript:void(0)">
              <span class="nav-icon">${SVG.projects}</span><span>项目列表</span>
            </a>
            ${isAdmin ? `
              <a class="nav-link ${currentTab === "log_db" ? "active" : ""}" id="tab-log-db-btn" href="javascript:void(0)">
                <span class="nav-icon">${SVG.database}</span><span>日志数据库管理</span>
              </a>
              <a class="nav-link ${currentTab === "users" ? "active" : ""}" id="tab-users-btn" href="javascript:void(0)">
                <span class="nav-icon">${SVG.users}</span><span>用户与权限管理</span>
              </a>
            ` : ""}
          </nav>

          <!-- 底部账号与退出登录 -->
          <div class="sidebar-footer" style="padding-top:14px;border-top:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:space-between">
            <div class="user-chip" id="open-my-profile" style="margin:0;cursor:pointer" title="点击修改个人资料与密码">
              <span class="avatar">${escapeHtml(initial)}</span>
              <div class="user-chip-text">
                <strong style="font-size:13px;display:flex;align-items:center;gap:4px">${escapeHtml(account.display_name || account.username)} <span style="opacity:0.7">${SVG.gear}</span></strong>
                <span style="font-size:11px;color:rgba(255,255,255,0.5)">${escapeHtml(account.role || "user")}</span>
              </div>
            </div>
            <button class="button button-ghost button-small" id="logout-button" style="color:#f87171;border:1px solid rgba(248,113,113,0.3);padding:4px 10px;font-size:12px;white-space:nowrap" title="退出当前账号">
              退出登录
            </button>
          </div>
        </aside>

        <section class="workspace">
          <header class="topbar">
            <div style="display:flex;align-items:center;gap:10px">
              <span style="font-size:14px;font-weight:700;color:var(--ink-900)">
                ${currentTab === "projects" ? "项目空间" : currentTab === "log_db" ? "全站日志数据库管理" : "全站用户与权限管理"}
              </span>
            </div>
            <div style="display:flex;align-items:center;gap:12px">
              <span style="font-size:12px;color:var(--ink-500)">
                当前用户: <strong style="color:var(--ink-800)">${escapeHtml(account.display_name || account.username)}</strong>
              </span>
              <button class="button button-secondary button-small" id="topbar-my-profile" style="font-size:11px;display:flex;align-items:center;gap:4px">${SVG.gear} 个人设置</button>
            </div>
          </header>
          <main class="content" id="main-workspace-content">
            ${loading("正在加载页面数据…")}
          </main>
        </section>
      </div>
    `;

    root.querySelector("#logout-button")?.addEventListener("click", onLogout);
    root.querySelector("#open-my-profile")?.addEventListener("click", () => showProfileModal(root));
    root.querySelector("#topbar-my-profile")?.addEventListener("click", () => showProfileModal(root));

    root.querySelector("#tab-projects-btn")?.addEventListener("click", async () => {
      if (currentTab !== "projects") {
        currentTab = "projects";
        renderShell();
        await loadProjectsTab();
      }
    });

    root.querySelector("#tab-log-db-btn")?.addEventListener("click", async () => {
      if (currentTab !== "log_db") {
        currentTab = "log_db";
        renderShell();
        await loadLogDatabaseTab();
      }
    });

    root.querySelector("#tab-users-btn")?.addEventListener("click", async () => {
      if (currentTab !== "users") {
        currentTab = "users";
        renderShell();
        await loadUsersTab();
      }
    });
  }

  renderShell();
  await loadProjectsTab();


  // 1. 加载项目列表视图
  async function loadProjectsTab() {
    const content = root.querySelector("#main-workspace-content");
    if (!content) return;
    try {
      content.innerHTML = `
        <div class="page-header" style="margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
          <div>
            <h1 style="margin:0 0 4px 0">项目空间</h1>
            <p style="margin:0">${isAdmin ? "管理员权限：全站所有用户的项目空间及架构数据全景。" : "每个项目拥有独立的架构图谱、日志批次和故障处理记录。"}</p>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="position:relative;width:240px">
              <input type="text" id="project-search-input" class="input" placeholder="搜索项目名称或描述..." style="padding-left:32px;font-size:13px;height:36px" />
              <span style="position:absolute;left:10px;top:8px;color:var(--ink-400);font-size:14px;pointer-events:none">🔍</span>
            </div>
            <button class="button button-primary" id="create-project" style="display:flex;align-items:center;gap:6px;height:36px;white-space:nowrap">${SVG.plus} 新建项目</button>
          </div>
        </div>
        <div id="projects-content-area">${loading("正在拉取项目列表…")}</div>
      `;

      content.querySelector("#create-project")?.addEventListener("click", () => showProjectModal(root, loadProjectsTab));
      const area = content.querySelector("#projects-content-area");
      const searchInput = content.querySelector("#project-search-input");

      const { items } = await api.projects();
      items.forEach(cacheProject);

      function renderProjectGrid(projectList) {
        if (!items.length) {
          area.innerHTML = emptyState(
            "还没有项目",
            "先创建一个项目，再导入该系统的架构描述。",
            `<button class="button button-primary" id="empty-create" style="display:inline-flex;align-items:center;gap:6px">${SVG.plus} 创建第一个项目</button>`,
          );
          area.querySelector("#empty-create")?.addEventListener("click", () => showProjectModal(root, loadProjectsTab));
          return;
        }

        if (!projectList.length) {
          area.innerHTML = emptyState(
            "未找到匹配的项目",
            "尝试使用其他搜索关键词，或清除搜索框内容。",
            `<button class="button button-secondary button-small" id="clear-search-btn">重置搜索</button>`
          );
          area.querySelector("#clear-search-btn")?.addEventListener("click", () => {
            if (searchInput) searchInput.value = "";
            renderProjectGrid(items);
          });
          return;
        }

        area.innerHTML = `<div class="grid grid-3">
          ${projectList.map((project) => {
            const statusBadge = project.status === "paused"
              ? '<span class="badge badge-warning" style="font-size:10px;padding:2px 6px">已暂停</span>'
              : project.status === "archived"
              ? '<span class="badge" style="font-size:10px;padding:2px 6px;background:#94a3b8;color:#fff">已归档</span>'
              : '<span class="badge badge-success" style="font-size:10px;padding:2px 6px">正常运行</span>';

            return `
              <div class="card project-card" style="display:flex;flex-direction:column;justify-content:space-between;transition:transform 0.15s ease, box-shadow 0.15s ease">
                <div>
                  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:8px">
                    <div style="display:flex;align-items:center;gap:8px">
                      <span class="project-symbol" style="margin:0">${escapeHtml(project.name.slice(0, 1).toUpperCase())}</span>
                      ${statusBadge}
                    </div>
                    <div style="display:flex;align-items:center;gap:6px">
                      <button class="button button-ghost button-small project-edit-btn" data-edit-id="${project.id}" title="编辑项目属性" style="color:var(--brand);padding:3px 8px;font-size:12px;background:rgba(37,99,235,0.08);border:1px solid rgba(37,99,235,0.2);display:inline-flex;align-items:center;gap:3px">
                        ${SVG.pencil} 编辑
                      </button>
                      <button class="button button-ghost button-small project-delete-btn" data-delete-id="${project.id}" data-delete-name="${escapeHtml(project.name)}" title="删除此项目" style="color:var(--danger);padding:3px 8px;font-size:12px;background:rgba(220,38,38,0.06);border:1px solid rgba(220,38,38,0.2)">
                        删除
                      </button>
                    </div>
                  </div>
                  <a href="#/projects/${encodeURIComponent(project.id)}/overview" style="text-decoration:none;color:inherit;display:block">
                    <h2 style="font-size:16px;font-weight:700;margin-bottom:6px;word-break:break-all">${escapeHtml(project.name)}</h2>
                    <p style="color:var(--ink-600);font-size:13px;line-height:1.5;margin-bottom:14px">${escapeHtml(project.description || "暂无项目描述")}</p>
                  </a>
                </div>
                <a href="#/projects/${encodeURIComponent(project.id)}/overview" style="text-decoration:none;color:inherit;display:block">
                  <div class="project-meta" style="border-top:1px solid var(--border);padding-top:10px;margin-top:auto;display:flex;align-items:center;justify-content:space-between">
                    <div>
                      <span style="font-size:11px;color:var(--ink-500);display:block">创建者: <strong style="color:var(--ink-700)">${escapeHtml(project.owner_display_name || project.owner_name || "创建人")}</strong></span>
                      <span style="font-size:10px;color:var(--ink-400)">${formatDate(project.updated_at)}</span>
                    </div>
                    <strong style="color:var(--brand);font-size:12px">进入项目 →</strong>
                  </div>
                </a>
              </div>
            `;
          }).join("")}
          <button class="card project-card new-project-card" id="card-create" style="min-height:160px">
            <span class="project-symbol" style="display:inline-flex;align-items:center;justify-content:center">${SVG.plus}</span>
            <strong>新建项目</strong>
            <span class="field-hint">创建独立图谱与日志空间</span>
          </button>
        </div>`;

        area.querySelector("#card-create")?.addEventListener("click", () => showProjectModal(root, loadProjectsTab));

        // 绑定编辑按钮事件
        area.querySelectorAll(".project-edit-btn").forEach((button) => {
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            event.preventDefault();
            const projectId = button.dataset.editId;
            const target = items.find((p) => String(p.id) === String(projectId));
            if (target) {
              showProjectModal(root, loadProjectsTab, target);
            }
          });
        });

        // 绑定删除按钮事件
        area.querySelectorAll(".project-delete-btn").forEach((button) => {
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
              await loadProjectsTab();
            } catch (error) {
              toast(error.message, "error");
              setBusy(button, false);
            }
          });
        });
      }

      renderProjectGrid(items);

      // 实时搜索监听
      searchInput?.addEventListener("input", (e) => {
        const query = (e.target.value || "").trim().toLowerCase();
        if (!query) {
          renderProjectGrid(items);
          return;
        }
        const filtered = items.filter(
          (p) =>
            (p.name && p.name.toLowerCase().includes(query)) ||
            (p.description && p.description.toLowerCase().includes(query)) ||
            (p.owner_name && p.owner_name.toLowerCase().includes(query)) ||
            (p.owner_display_name && p.owner_display_name.toLowerCase().includes(query))
        );
        renderProjectGrid(filtered);
      });

    } catch (error) {
      content.innerHTML = errorState(error, "retry-projects");
      content.querySelector("#retry-projects")?.addEventListener("click", loadProjectsTab);
    }
  }

  // 2. 加载用户与权限管理视图 (管理员专属)
  async function loadUsersTab() {
    const content = root.querySelector("#main-workspace-content");
    if (!content) return;
    try {
      content.innerHTML = `
        <div class="page-header">
          <div>
            <h1>用户与权限管理</h1>
            <p>管理全站注册用户、修改姓名/重置密码、角色权限（管理员 / 普通用户）及账号启用/停用状态。</p>
          </div>
        </div>
        <div id="users-content-area">${loading("正在拉取用户列表…")}</div>
      `;

      const area = content.querySelector("#users-content-area");
      const { items } = await api.users();

      area.innerHTML = `
        <section class="card">
          <div class="card-header">
            <div>
              <h2>系统用户名录 (${items.length} 人)</h2>
              <p>管理员可以修改用户姓名、重置密码、调整角色权限及账号状态。</p>
            </div>
          </div>
          <div class="card-body flush">
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>用户名 / 显示名 / 工号</th>
                    <th>账号角色</th>
                    <th>账号状态</th>
                    <th>注册时间</th>
                    <th>操作与权限设定</th>
                  </tr>
                </thead>
                <tbody>
                  ${items.map((u) => `
                    <tr>
                      <td>
                        <div style="display:flex;align-items:center;gap:10px">
                          <span class="avatar" style="width:32px;height:32px;font-size:12px">${escapeHtml((u.display_name || u.username).slice(0, 1).toUpperCase())}</span>
                          <div>
                            <strong style="display:block;font-size:13px">${escapeHtml(u.username)}</strong>
                            <span style="font-size:11px;color:var(--ink-500)">${escapeHtml(u.display_name || u.username)}</span>
                            <span style="display:block;font-size:11px;color:var(--ink-500)">工号：${escapeHtml(u.employee_id || "未设置")}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span class="badge ${u.role === "admin" ? "badge-critical" : "badge-info"}">
                          ${u.role === "admin" ? "管理员" : "普通用户"}
                        </span>
                      </td>
                      <td>
                        <span class="badge ${u.is_active ? "badge-resolved" : "badge-ignored"}">
                          ${u.is_active ? "正常启用" : "已停用"}
                        </span>
                      </td>
                      <td>
                        <span style="font-size:12px;color:var(--ink-500)">${formatDate(u.created_at)}</span>
                      </td>
                      <td>
                        <div style="display:flex;align-items:center;gap:8px">
                          <button class="button button-secondary button-small edit-user-btn" data-user-json='${escapeHtml(JSON.stringify(u))}' style="font-size:11px;padding:4px 8px;border-radius:6px;display:flex;align-items:center;gap:4px">
                            ${SVG.pencil} 编辑
                          </button>
                          <select class="role-select" data-user-id="${u.id}" data-is-active="${u.is_active}" style="font-size:12px;padding:5px 12px;border-radius:6px;border:1.5px solid var(--brand, #2563eb);background:#ffffff;color:var(--ink-800);font-weight:600;cursor:pointer;outline:none;box-shadow:0 1px 3px rgba(37,99,235,0.12)">
                            <option value="user" ${u.role === "user" ? "selected" : ""}>普通用户</option>
                            <option value="admin" ${u.role === "admin" ? "selected" : ""}>管理员</option>
                          </select>
                          ${u.role === "admin" ? `
                            <button class="button button-ghost button-small" disabled title="出于系统安全保护，管理员账号不可被停用" style="font-size:12px;padding:4px 12px;border-radius:6px;border:1px solid var(--border);color:var(--ink-400);background:var(--surface-soft);opacity:0.6;cursor:not-allowed">
                              不可停用
                            </button>
                          ` : `
                            <button class="button button-ghost button-small toggle-active-btn" data-user-id="${u.id}" data-role="${u.role}" data-is-active="${u.is_active}" style="font-size:12px;padding:4px 12px;border-radius:6px;border:1px solid ${u.is_active ? 'rgba(220,38,38,0.3)' : 'rgba(22,163,74,0.3)'};color:${u.is_active ? '#dc2626' : '#16a34a'};background:${u.is_active ? 'rgba(220,38,38,0.05)' : 'rgba(22,163,74,0.05)'}">
                              ${u.is_active ? "停用" : "启用"}
                            </button>
                          `}
                        </div>
                      </td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      `;

      // 绑定编辑账号按钮事件
      area.querySelectorAll(".edit-user-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          try {
            const userObj = JSON.parse(btn.dataset.userJson);
            showAdminEditUserModal(root, userObj, loadUsersTab);
          } catch (e) {
            console.error("解析用户失败", e);
          }
        });
      });

      // 绑定角色切换下拉框事件
      area.querySelectorAll(".role-select").forEach((select) => {
        select.addEventListener("change", async (e) => {
          const userId = select.dataset.userId;
          const isActive = Number(select.dataset.isActive);
          const newRole = e.target.value;
          try {
            await api.updateUser(userId, { role: newRole, is_active: isActive });
            toast("用户角色权限已成功更新");
            await loadUsersTab();
          } catch (err) {
            toast(err.message, "error");
            await loadUsersTab();
          }
        });
      });

      // 绑定账号启停按钮事件
      area.querySelectorAll(".toggle-active-btn").forEach((button) => {
        button.addEventListener("click", async () => {
          const userId = button.dataset.userId;
          const role = button.dataset.role;
          const currentActive = Number(button.dataset.isActive);
          const newActive = currentActive === 1 ? 0 : 1;
          try {
            await api.updateUser(userId, { role: role, is_active: newActive });
            toast(`用户状态已切换为${newActive === 1 ? '启用' : '停用'}`);
            await loadUsersTab();
          } catch (err) {
            toast(err.message, "error");
          }
        });
      });

    } catch (error) {
      content.innerHTML = errorState(error, "retry-users");
      content.querySelector("#retry-users")?.addEventListener("click", loadUsersTab);
    }
  }

  // 3. 加载全站日志数据库管理视图
  async function loadLogDatabaseTab() {
    const content = root.querySelector("#main-workspace-content");
    if (!content) return;

    try {
      content.innerHTML = loading("正在加载全站日志数据库与资产看板…");

      const [stats, projectsRes, batchesRes] = await Promise.all([
        api.adminLogStats(),
        api.projects(false),
        api.adminLogBatches(logDbState),
      ]);

      const projectsList = projectsRes.items || projectsRes || [];
      const items = batchesRes.items || [];
      const total = batchesRes.total || 0;
      const page = batchesRes.page || 1;
      const limit = batchesRes.limit || 15;
      const totalPages = Math.ceil(total / limit) || 1;

      content.innerHTML = `
        <div class="page-header">
          <div>
            <h1 style="display:flex;align-items:center;gap:8px">
              全站日志数据库管理
            </h1>
            <p>跨项目日志批次资产管理、存储空间盘点、全量/故障数据视图切换、日志查验与结构化分析。</p>
          </div>
        </div>

        <!-- 1. 顶部全站统计看板 -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(210px, 1fr));gap:16px;margin-bottom:20px">
          <div style="background:#ffffff;border:1px solid var(--border);border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,0.04)">
            <div style="font-size:12px;color:var(--ink-500);margin-bottom:4px">全站日志批次</div>
            <div style="font-size:22px;font-weight:700;color:var(--ink-900)">${stats.total_batches || 0} <small style="font-size:12px;font-weight:400;color:var(--ink-500)">批</small></div>
            <div style="font-size:11px;color:var(--ink-500);margin-top:4px">完成: <strong style="color:#16a34a">${stats.total_completed || 0}</strong> | 处理中: <strong>${stats.total_processing || 0}</strong> | 失败: <strong style="color:#dc2626">${stats.total_failed || 0}</strong></div>
          </div>
          <div style="background:#ffffff;border:1px solid var(--border);border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,0.04)">
            <div style="font-size:12px;color:var(--ink-500);margin-bottom:4px">磁盘存储容量占用</div>
            <div style="font-size:22px;font-weight:700;color:#2563eb">${formatBytes(stats.total_file_size_bytes || 0)}</div>
            <div style="font-size:11px;color:var(--ink-500);margin-top:4px">包含输入日志包与解析产物文件</div>
          </div>
          <div style="background:#ffffff;border:1px solid var(--border);border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,0.04)">
            <div style="font-size:12px;color:var(--ink-500);margin-bottom:4px">全站解析日志行数</div>
            <div style="font-size:22px;font-weight:700;color:#059669">${(stats.total_parsed_lines || 0).toLocaleString()} <small style="font-size:12px;font-weight:400;color:var(--ink-500)">行</small></div>
            <div style="font-size:11px;color:var(--ink-500);margin-top:4px">Drain / LFA 算法聚类压缩处理</div>
          </div>
          <div style="background:#ffffff;border:1px solid var(--border);border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,0.04)">
            <div style="font-size:12px;color:var(--ink-500);margin-bottom:4px">含故障日志批次 / 事件总数</div>
            <div style="font-size:22px;font-weight:700;color:#dc2626">${stats.fault_batches || 0} <span style="font-size:14px;font-weight:600;color:var(--ink-600)">/ ${stats.total_incidents || 0} 起</span></div>
            <div style="font-size:11px;color:var(--ink-500);margin-top:4px">RCA 异常检测与根因传播定位</div>
          </div>
        </div>

        <!-- 2. 多维检索与筛选栏 -->
        <div style="background:#ffffff;border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:18px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px">
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;flex:1">
            <select id="log-db-project-select" class="input" style="font-size:12px;padding:5px 10px;width:auto;height:34px">
              <option value="">全部项目</option>
              ${projectsList.map((p) => `<option value="${p.id}" ${logDbState.project_id === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
            </select>

            <select id="log-db-fault-select" class="input" style="font-size:12px;padding:5px 10px;width:auto;height:34px">
              <option value="" ${logDbState.has_fault === "" ? "selected" : ""}>全部日志 (全量视图)</option>
              <option value="true" ${logDbState.has_fault === "true" ? "selected" : ""}>仅含故障日志批次</option>
              <option value="false" ${logDbState.has_fault === "false" ? "selected" : ""}>正常日志批次 (无异常)</option>
            </select>

            <select id="log-db-status-select" class="input" style="font-size:12px;padding:5px 10px;width:auto;height:34px">
              <option value="" ${logDbState.status === "" ? "selected" : ""}>全部状态</option>
              <option value="completed" ${logDbState.status === "completed" ? "selected" : ""}>解析完成</option>
              <option value="processing" ${logDbState.status === "processing" ? "selected" : ""}>处理中</option>
              <option value="failed" ${logDbState.status === "failed" ? "selected" : ""}>解析失败</option>
            </select>

            <input type="text" id="log-db-search-input" class="input" placeholder="搜索文件名 / 上传人..." value="${escapeHtml(logDbState.search)}" style="font-size:12px;padding:5px 10px;width:190px;height:34px" />

            <button id="log-db-search-btn" class="button button-primary button-small" style="font-size:12px;height:34px">查询</button>
            <button id="log-db-reset-btn" class="button button-secondary button-small" style="font-size:12px;height:34px">重置</button>
          </div>

          <div style="font-size:12px;color:var(--ink-500)">
            共查获 <strong>${total}</strong> 个日志批次
          </div>
        </div>

        <!-- 3. 数据表格 -->
        <section class="card" style="padding:0;overflow:hidden">
          ${items.length === 0 ? emptyState("暂无匹配的日志批次数据", "可尝试调整检索条件或在对应项目中上传新的日志包。") : `
            <div style="overflow-x:auto">
              <table class="table" style="margin:0">
                <thead>
                  <tr>
                    <th>所属项目</th>
                    <th>日志文件名</th>
                    <th>上传人</th>
                    <th>容量 / 行数</th>
                    <th>上传时间</th>
                    <th>解析状态</th>
                    <th>故障检测结果</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${items.map((b) => {
                    const hasIncident = (b.incident_count || 0) > 0;
                    const summary = b.summary || {};
                    const totalLines = summary.events || summary.lines_count || summary.total_lines || "-";
                    return `
                      <tr>
                        <td>
                          <a href="#/projects/${encodeURIComponent(b.project_id)}/overview" title="点击进入项目控制台" style="font-size:13px;font-weight:700;color:#2563eb;text-decoration:none">
                            ${escapeHtml(b.project_name || "未知项目")}
                          </a>
                        </td>
                        <td>
                          <div style="display:flex;flex-direction:column">
                            <strong style="font-size:13px">${escapeHtml(b.filename)}</strong>
                            <small style="font-size:11px;color:var(--ink-400)">ID: ${escapeHtml(b.id.slice(0, 12))}</small>
                          </div>
                        </td>
                        <td>
                          <span style="font-size:12px;color:var(--ink-700)">${escapeHtml(b.creator_display_name || b.creator_username || "未知")}</span>
                        </td>
                        <td>
                          <div style="display:flex;flex-direction:column">
                            <span style="font-size:12px;font-weight:600;color:var(--ink-800)">${formatBytes(b.file_size_bytes)}</span>
                            <small style="font-size:11px;color:var(--ink-500)">${totalLines} 行日志</small>
                          </div>
                        </td>
                        <td>
                          <span style="font-size:12px;color:var(--ink-500)">${formatDate(b.created_at)}</span>
                        </td>
                        <td>
                          <span class="badge ${b.status === "completed" ? "badge-resolved" : b.status === "processing" ? "badge-info" : "badge-critical"}">
                            ${b.status === "completed" ? "解析完成" : b.status === "processing" ? "处理中" : "失败"}
                          </span>
                        </td>
                        <td>
                          ${hasIncident ? `
                            <a href="#/projects/${encodeURIComponent(b.project_id)}/incidents?batch=${encodeURIComponent(b.id)}" class="badge badge-critical" style="font-weight:600;text-decoration:none;display:inline-flex;align-items:center;gap:4px" title="点击查看故障事件列表">
                              触发 ${b.incident_count} 起故障事件 ➔
                            </a>
                          ` : `
                            <span class="badge badge-resolved" style="opacity:0.85">
                              正常无异常
                            </span>
                          `}
                        </td>
                        <td>
                          <div style="display:flex;align-items:center;gap:8px">
                            <button class="button button-secondary button-small btn-analytics" data-batch-id="${b.id}" style="font-size:11px;padding:4px 10px;font-weight:600" title="查看日志分析结果、结构化模板与关联故障">
                              查看分析
                            </button>
                            <button class="button button-ghost button-small btn-delete-batch" data-batch-id="${b.id}" data-filename="${escapeHtml(b.filename)}" style="font-size:11px;padding:4px 8px;color:#dc2626" title="安全删除文件及关联数据">
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    `;
                  }).join("")}
                </tbody>
              </table>
            </div>

            <!-- 分页器 -->
            <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-top:1px solid var(--border);background:var(--surface-soft)">
              <span style="font-size:12px;color:var(--ink-500)">第 ${page} / ${totalPages} 页</span>
              <div style="display:flex;gap:8px">
                <button id="log-db-prev-page" class="button button-secondary button-small" ${page <= 1 ? "disabled" : ""} style="font-size:12px">上一页</button>
                <button id="log-db-next-page" class="button button-secondary button-small" ${page >= totalPages ? "disabled" : ""} style="font-size:12px">下一页</button>
              </div>
            </div>
          `}
        </section>
      `;

      // 绑定检索事件
      const doSearch = async () => {
        logDbState.project_id = content.querySelector("#log-db-project-select").value;
        logDbState.has_fault = content.querySelector("#log-db-fault-select").value;
        logDbState.status = content.querySelector("#log-db-status-select").value;
        logDbState.search = content.querySelector("#log-db-search-input").value.trim();
        logDbState.page = 1;
        await loadLogDatabaseTab();
      };

      content.querySelector("#log-db-search-btn")?.addEventListener("click", doSearch);
      content.querySelector("#log-db-search-input")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doSearch();
      });

      content.querySelector("#log-db-reset-btn")?.addEventListener("click", async () => {
        logDbState = { page: 1, limit: 15, project_id: "", status: "", has_fault: "", search: "" };
        await loadLogDatabaseTab();
      });

      // 绑定分页事件
      content.querySelector("#log-db-prev-page")?.addEventListener("click", async () => {
        if (logDbState.page > 1) {
          logDbState.page--;
          await loadLogDatabaseTab();
        }
      });

      content.querySelector("#log-db-next-page")?.addEventListener("click", async () => {
        logDbState.page++;
        await loadLogDatabaseTab();
      });

      // 绑定数据列操作
      content.querySelectorAll(".btn-analytics").forEach((btn) => {
        btn.addEventListener("click", () => {
          showLogBatchAnalyticsModal(root, btn.dataset.batchId);
        });
      });

      content.querySelectorAll(".btn-delete-batch").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const batchId = btn.dataset.batchId;
          const filename = btn.dataset.filename;
          if (!confirm(`确定要彻底删除日志批次“${filename}”及其关联的图谱节点与磁盘数据吗？`)) return;
          setBusy(btn, true, "删除中...");
          try {
            await api.adminDeleteLogBatch(batchId);
            toast(`日志批次“${filename}”已安全擦除`);
            await loadLogDatabaseTab();
          } catch (err) {
            toast(err.message, "error");
            setBusy(btn, false);
          }
        });
      });

    } catch (err) {
      content.innerHTML = errorState(err, "retry-log-db");
      content.querySelector("#retry-log-db")?.addEventListener("click", loadLogDatabaseTab);
    }
  }
}


// 个人设置弹窗 (支持所有用户自行修改姓名与密码)
function showProfileModal(root) {
  const account = user() || {};
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" style="max-width:440px">
      <header class="modal-header">
        <h2 id="modal-title" style="display:flex;align-items:center;gap:6px">${SVG.gear} 个人账号设置</h2>
        <button class="button button-ghost" data-close aria-label="关闭">✕</button>
      </header>
      <div class="modal-body">
        <form class="form-stack" id="profile-form">
          <div class="field">
            <label>登录用户名</label>
            <input class="input" value="${escapeHtml(account.username)}" disabled style="background:var(--surface-soft);opacity:0.7;cursor:not-allowed" />
            <span class="field-hint">用户名用于登录验证，不可修改</span>
          </div>
          <div class="field">
            <label for="profile-display-name">显示姓名 / 团队称呼</label>
            <input class="input" id="profile-display-name" name="display_name" value="${escapeHtml(account.display_name || account.username)}" required maxlength="120" />
          </div>
          <div class="field">
            <label for="profile-employee-id">工号</label>
            <input class="input" id="profile-employee-id" name="employee_id" value="${escapeHtml(account.employee_id || "")}" required maxlength="64" />
            <span class="field-hint">远程大模型请求将使用该工号作为 X-Ai-Coding-Key</span>
          </div>
          <hr style="border:none;border-top:1px solid var(--border);margin:14px 0" />
          <span style="font-size:12px;font-weight:700;color:var(--ink-800);display:block;margin-bottom:8px">修改密码 (不填写则保持原密码不变)</span>
          <div class="field">
            <label for="profile-old-pass">当前旧密码</label>
            <input class="input" type="password" id="profile-old-pass" name="old_password" placeholder="若要更新密码，请输入旧密码" />
          </div>
          <div class="field">
            <label for="profile-new-pass">新密码</label>
            <input class="input" type="password" id="profile-new-pass" name="new_password" placeholder="包含至少 4 位字符" />
          </div>
          <div style="display:flex;justify-content:flex-end;gap:9px;margin-top:16px">
            <button type="button" class="button button-secondary" data-close>取消</button>
            <button class="button button-primary" id="save-profile" type="submit">保存修改</button>
          </div>
        </form>
      </div>
    </section>
  `;
  root.append(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector("#profile-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = backdrop.querySelector("#save-profile");
    setBusy(btn, true, "保存中…");
    try {
      const payload = Object.fromEntries(new FormData(e.currentTarget));
      const res = await api.updateProfile(payload);
      setUser(res.user);
      close();
      toast("个人账号信息已成功修改");
      setTimeout(() => window.location.reload(), 600);
    } catch (err) {
      toast(err.message, "error");
      setBusy(btn, false);
    }
  });
}

// 管理员编辑指定用户弹窗 (修改显示姓名或重置密码)
function showAdminEditUserModal(root, targetUser, onUpdated) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" style="max-width:440px">
      <header class="modal-header">
        <h2 id="modal-title" style="display:flex;align-items:center;gap:6px">${SVG.pencil} 编辑账号：${escapeHtml(targetUser.username)}</h2>
        <button class="button button-ghost" data-close aria-label="关闭">✕</button>
      </header>
      <div class="modal-body">
        <form class="form-stack" id="admin-user-form">
          <div class="field">
            <label>登录用户名</label>
            <input class="input" value="${escapeHtml(targetUser.username)}" disabled style="background:var(--surface-soft);opacity:0.7" />
          </div>
          <div class="field">
            <label for="admin-user-display">显示姓名 / 团队称呼</label>
            <input class="input" id="admin-user-display" name="display_name" value="${escapeHtml(targetUser.display_name || targetUser.username)}" required />
          </div>
          <div class="field">
            <label for="admin-user-employee-id">工号</label>
            <input class="input" id="admin-user-employee-id" name="employee_id" value="${escapeHtml(targetUser.employee_id || "")}" required maxlength="64" />
          </div>
          <div class="field">
            <label for="admin-user-role">账号角色</label>
            <select class="select" id="admin-user-role" name="role">
              <option value="user" ${targetUser.role === "user" ? "selected" : ""}>普通用户</option>
              <option value="admin" ${targetUser.role === "admin" ? "selected" : ""}>管理员</option>
            </select>
          </div>
          <div class="field">
            <label for="admin-user-active">账号状态</label>
            <select class="select" id="admin-user-active" name="is_active" ${targetUser.role === "admin" ? "disabled" : ""}>
              <option value="1" ${targetUser.is_active ? "selected" : ""}>正常启用</option>
              <option value="0" ${!targetUser.is_active ? "selected" : ""}>停用</option>
            </select>
            ${targetUser.role === "admin" ? `<span class="field-hint" style="color:var(--danger)">管理员账号受系统保护，不可被停用</span>` : ""}
          </div>
          <hr style="border:none;border-top:1px solid var(--border);margin:14px 0" />
          <div class="field">
            <label for="admin-user-reset-pass">重置新密码 (可选)</label>
            <input class="input" type="password" id="admin-user-reset-pass" name="new_password" placeholder="若无需重置，留空即可" />
            <span class="field-hint">管理员可以直接为此用户设置新密码，无需原密码</span>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:9px;margin-top:16px">
            <button type="button" class="button button-secondary" data-close>取消</button>
            <button class="button button-primary" id="admin-save-user" type="submit">保存修改</button>
          </div>
        </form>
      </div>
    </section>
  `;
  root.append(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
}

// 展现日志批次分析与故障明细浮层弹窗
async function showLogBatchAnalyticsModal(root, batchId) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<section class="modal" role="dialog" style="max-width:1400px;width:96%;margin:20px auto">
    <header class="modal-header">
      <h2 style="display:flex;align-items:center;gap:8px">
        日志批次分析与故障明细
      </h2>
      <button class="button button-ghost" data-close>✕</button>
    </header>
    <div class="modal-body" id="analytics-modal-body">
      ${loading("正在提取日志模板、结构化事件与关联诊断报告...")}
    </div>
  </section>`;
  root.append(backdrop);

  const close = () => backdrop.remove();
  backdrop.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  // 限制只能点击右上角的 ✕ 关闭弹窗，取消点击黑灰色遮罩区域自动关闭

  try {
    const res = await api.adminLogAnalytics(batchId);
    const body = backdrop.querySelector("#analytics-modal-body");
    if (!res || !body) return;

    const b = res.batch || {};
    const incidents = res.incidents || [];
    const templates = Array.isArray(res.templates) ? res.templates : [];
    const eventsSample = Array.isArray(res.events_sample) ? res.events_sample : [];
    const reportMd = res.report_md || "";
    const fileInfo = res.file_info || {};
    const summary = b.summary || {};

    const totalEvents = summary.events || summary.lines_count || summary.total_lines || 0;
    const compressionRatio = summary.compression_ratio ? `${(summary.compression_ratio * 100).toFixed(1)}%` : totalEvents > 0 && templates.length > 0 ? `${((1 - templates.length / totalEvents) * 100).toFixed(1)}%` : "N/A";

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:12px;margin-bottom:16px;background:var(--surface-soft);padding:12px 16px;border-radius:8px;border:1px solid var(--border)">
        <div><small style="color:var(--ink-500);display:block">所属项目</small><strong style="font-size:13px">${escapeHtml(b.project_name || "-")}</strong></div>
        <div><small style="color:var(--ink-500);display:block">日志文件名</small><strong style="font-size:13px;word-break:break-all">${escapeHtml(b.filename || "-")}</strong></div>
        <div><small style="color:var(--ink-500);display:block">磁盘占用容量</small><strong style="font-size:13px;color:#2563eb">${formatBytes(fileInfo.size_bytes)}</strong></div>
        <div><small style="color:var(--ink-500);display:block">解析日志总行数</small><strong style="font-size:13px;color:#059669">${totalEvents.toLocaleString()} 行</strong></div>
      </div>

      <!-- Tab Buttons -->
      <div style="display:flex;gap:12px;border-bottom:1px solid var(--border);margin-bottom:16px;flex-wrap:wrap">
        <button id="modal-tab-1" class="button button-ghost" style="border-bottom:2px solid #2563eb;border-radius:0;color:#2563eb;font-weight:600;padding:8px 6px">日志模板结构 (${templates.length})</button>
        <button id="modal-tab-2" class="button button-ghost" style="border-bottom:2px solid transparent;border-radius:0;color:var(--ink-600);padding:8px 6px">日志数据查看 (前 ${eventsSample.length} 行)</button>
        <button id="modal-tab-3" class="button button-ghost" style="border-bottom:2px solid transparent;border-radius:0;color:var(--ink-600);padding:8px 6px">故障事件明细 (${incidents.length})</button>
        ${reportMd ? `<button id="modal-tab-4" class="button button-ghost" style="border-bottom:2px solid transparent;border-radius:0;color:var(--ink-600);padding:8px 6px">RCA 诊断报告</button>` : ""}
      </div>

      <!-- Tabs Main Fixed Height Body -->
      <div id="modal-tabs-body" style="height:520px;min-height:520px;max-height:520px;position:relative">
        <!-- Tab 1: 模板结构 -->
        <div id="modal-tab-content-1" style="height:100%;display:flex;flex-direction:column">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;background:#f8fafc;padding:8px 12px;border-radius:6px;border:1px solid var(--border);flex-shrink:0">
            <span style="font-size:12px;color:var(--ink-700)">日志压缩率：<strong style="color:#059669">${compressionRatio}</strong></span>
            <span style="font-size:12px;color:var(--ink-700)">算法分析耗时：<strong>${summary.duration_seconds || "-"}s</strong></span>
          </div>
          ${templates.length === 0 ? emptyState("未提取到独立日志模板", "已提取日志基础概览。") : `
            <div style="flex:1;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
              <table class="table" style="margin:0;font-size:12px">
                <thead>
                  <tr>
                    <th style="width:70px">模板ID</th>
                    <th>日志模板表达式 (Drain / LFA)</th>
                    <th style="width:80px;text-align:right">出现频次</th>
                  </tr>
                </thead>
                <tbody>
                  ${templates.map((t) => `
                    <tr>
                      <td><code>${escapeHtml(String(t.id || "-"))}</code></td>
                      <td style="font-family:monospace;word-break:break-all;font-size:11px">${escapeHtml(t.template || "")}</td>
                      <td style="text-align:right"><strong>${t.count || 1}</strong></td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          `}
        </div>

        <!-- Tab 2: 全量日志样例查看 -->
        <div id="modal-tab-content-2" style="height:100%;display:none;flex-direction:column">
          ${eventsSample.length === 0 ? emptyState("未查找到抽取出的日志明细", "可在所在项目中查看原始上传包。") : `
            <div style="flex:1;overflow-y:auto;border:1px solid var(--border);border-radius:6px;background:#1e293b;color:#e2e8f0;padding:14px;font-family:Consolas, monospace;font-size:11px;line-height:1.6">
              ${eventsSample.map((ev, idx) => {
                const text = ev.Content || ev.content || ev.EventTemplate || JSON.stringify(ev);
                const timestamp = ev.Timestamp || ev.timestamp || ev.time || "";
                const level = ev.Level || ev.level || "INFO";
                const isErr = String(level).toUpperCase().includes("ERR") || String(text).toUpperCase().includes("EXCEPTION");
                return `<div style="margin-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:4px;color:${isErr ? '#f87171' : '#cbd5e1'}">
                  <span style="color:#94a3b8">[#${idx + 1}]</span>
                  ${timestamp ? `<span style="color:#38bdf8">[${escapeHtml(timestamp)}]</span>` : ""}
                  <span style="font-weight:700;color:${isErr ? '#ef4444' : '#4ade80'}">${escapeHtml(level)}</span>:
                  <span>${escapeHtml(text)}</span>
                </div>`;
              }).join("")}
            </div>
          `}
        </div>

        <!-- Tab 3: 故障事件明细 -->
        <div id="modal-tab-content-3" style="height:100%;display:none;flex-direction:column">
          ${incidents.length === 0 ? emptyState("未检测到故障告警", "该日志批次运行正常，未匹配到根因诊断策略异常点。") : `
            <div style="flex:1;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
              <table class="table" style="margin:0;font-size:12px">
                <thead>
                  <tr>
                    <th>故障事件编号</th>
                    <th>严重度</th>
                    <th>根因候选服务</th>
                    <th>定位置信度</th>
                    <th>诊断详情与图谱</th>
                  </tr>
                </thead>
                <tbody>
                  ${incidents.map((i) => `
                    <tr>
                      <td><strong>${escapeHtml(i.external_incident_id || i.id.slice(0, 8))}</strong></td>
                      <td>
                        <span class="badge ${i.severity === "critical" ? "badge-critical" : "badge-info"}">${escapeHtml(i.severity)}</span>
                      </td>
                      <td><strong style="color:#2563eb">${escapeHtml(i.root_candidate || "未知服务")}</strong></td>
                      <td><strong>${((i.root_confidence || 0) * 100).toFixed(0)}%</strong></td>
                      <td>
                        <a href="#/projects/${encodeURIComponent(b.project_id)}/incidents/${encodeURIComponent(i.id)}" class="button button-primary button-small" style="font-size:11px;padding:3px 8px;text-decoration:none">
                          查看故障图谱 ➔
                        </a>
                      </td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          `}
        </div>

        <!-- Tab 4: RCA 报告 -->
        ${reportMd ? `
          <div id="modal-tab-content-4" style="height:100%;display:none;flex-direction:column">
            <div style="flex:1;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:16px;background:#f8fafc;font-size:12px;line-height:1.6;white-space:pre-wrap;font-family:monospace">
              ${escapeHtml(reportMd)}
            </div>
          </div>
        ` : ""}
      </div>
    `;

    // Tab Switch Events
    const t1 = body.querySelector("#modal-tab-1");
    const t2 = body.querySelector("#modal-tab-2");
    const t3 = body.querySelector("#modal-tab-3");
    const t4 = body.querySelector("#modal-tab-4");
    const c1 = body.querySelector("#modal-tab-content-1");
    const c2 = body.querySelector("#modal-tab-content-2");
    const c3 = body.querySelector("#modal-tab-content-3");
    const c4 = body.querySelector("#modal-tab-content-4");

    const tabs = [
      [t1, c1],
      [t2, c2],
      [t3, c3],
      [t4, c4],
    ].filter(([t]) => !!t);

    tabs.forEach(([btn, contentDiv]) => {
      btn.addEventListener("click", () => {
        tabs.forEach(([bItem, cItem]) => {
          bItem.style.borderBottomColor = "transparent";
          bItem.style.color = "var(--ink-600)";
          bItem.style.fontWeight = "normal";
          cItem.style.display = "none";
        });
        btn.style.borderBottomColor = "#2563eb";
        btn.style.color = "#2563eb";
        btn.style.fontWeight = "600";
        contentDiv.style.display = "flex";
      });
    });

  } catch (err) {
    backdrop.querySelector("#analytics-modal-body").innerHTML = errorState(err, "retry-analytics");
  }
}

// 展现新建/编辑项目弹窗
export function showProjectModal(root, onSaved, projectToEdit = null) {
  const isEdit = !!projectToEdit;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <section class="modal" role="dialog" style="max-width:540px;width:90%">
      <header class="modal-header">
        <h2 style="display:flex;align-items:center;gap:8px">
          ${isEdit ? `${SVG.pencil} 编辑项目` : `${SVG.plus} 新建项目`}
        </h2>
        <button class="button button-ghost" data-close>✕</button>
      </header>
      <div class="modal-body">
        <form id="project-form">
          <div class="field">
            <label for="project-name-input">项目名称 <span style="color:var(--danger)">*</span></label>
            <input class="input" type="text" id="project-name-input" name="name" required placeholder="例如：电商微服务集群系统" value="${escapeHtml(projectToEdit?.name || "")}" />
            <span class="field-hint">建议使用具有标识度的系统或项目名称</span>
          </div>

          <div class="field" style="margin-top:14px">
            <label for="project-desc-input">项目描述</label>
            <textarea class="input" id="project-desc-input" name="description" rows="3" placeholder="填写该项目的架构特点、核心模块或负责团队...">${escapeHtml(projectToEdit?.description || "")}</textarea>
          </div>

          ${isEdit ? `
            <div class="field" style="margin-top:14px">
              <label for="project-status-input">项目运行状态</label>
              <select class="select" id="project-status-input" name="status">
                <option value="active" ${projectToEdit.status === "active" ? "selected" : ""}>🟢 正常运行 (active)</option>
                <option value="paused" ${projectToEdit.status === "paused" ? "selected" : ""}>🟡 暂停检测 (paused)</option>
                <option value="archived" ${projectToEdit.status === "archived" ? "selected" : ""}>⚪ 已归档 (archived)</option>
              </select>
              <span class="field-hint">状态更新将同步影响该项目的日志诊断与监控调度</span>
            </div>
          ` : ""}

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px;padding-top:14px;border-top:1px solid var(--border)">
            <button type="button" class="button button-secondary" data-close>取消</button>
            <button type="submit" class="button button-primary" id="save-project-btn">
              ${isEdit ? "保存修改" : "立即创建项目"}
            </button>
          </div>
        </form>
      </div>
    </section>
  `;

  root.append(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  const form = backdrop.querySelector("#project-form");
  const saveBtn = backdrop.querySelector("#save-project-btn");

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const formData = new FormData(form);
    const name = (formData.get("name") || "").toString().trim();
    const description = (formData.get("description") || "").toString().trim();
    const status = (formData.get("status") || "active").toString().trim();

    if (!name) {
      toast("请输入项目名称", "error");
      return;
    }

    setBusy(saveBtn, true, isEdit ? "保存中…" : "创建中…");
    try {
      if (isEdit) {
        await api.updateProject(projectToEdit.id, { name, description, status });
        toast(`项目“${name}”配置更新成功`);
      } else {
        await api.createProject({ name, description });
        toast(`项目“${name}”创建成功`);
      }
      close();
      if (typeof onSaved === "function") await onSaved();
    } catch (err) {
      toast(err.message || "操作失败", "error");
      setBusy(saveBtn, false);
    }
  });
}



