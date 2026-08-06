import { user } from "./auth.js";
import { APP_VERSION } from "./config.js";
import { escapeHtml } from "./ui.js";
import { taskManager } from "./taskManager.js";

const icons = {
  overview: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>`,
  architecture: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>`,
  logs: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>`,
  incidents: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`,
};

const navItems = [
  ["overview", "总览"],
  ["architecture", "系统架构拓扑"],
  ["logs", "日志解析检测"],
  ["incidents", "故障根因定位"],
];

export function projectShell(project, current, content) {
  const account = user() || {};
  const initial = (account.display_name || account.username || "U").slice(0, 1).toUpperCase();
  const navigation = navItems.map(([key, label]) => {
    const suffix = key === "overview" ? "overview" : key;
    return `<a class="nav-link ${key === current ? "active" : ""}" href="#/projects/${encodeURIComponent(project.id)}/${suffix}">
      <span class="nav-icon">${icons[key]}</span><span>${label}</span>
    </a>`;
  }).join("");

  return `<div class="app-shell" id="app-shell">
    <aside class="sidebar">
      <a class="brand" href="#/projects"><span class="brand-mark">L</span><span>LogScope RCA <small class="brand-version">${escapeHtml(APP_VERSION)}</small></span></a>
      
      <!-- 项目选择与切回项目列表 (专属项目层级) -->
      <a class="project-switcher" href="#/projects" title="点击返回所有项目列表" style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;margin-bottom:14px">
        <div>
          <small style="display:block;font-size:11px;color:rgba(255,255,255,0.6)">当前项目 · 点击切换</small>
          <strong style="font-size:13px;color:#ffffff">${escapeHtml(project.name)}</strong>
        </div>
        <span style="font-size:11px;padding:3px 7px;border-radius:4px;background:rgba(255,255,255,0.12);color:rgba(255,255,255,0.85);white-space:nowrap">所有项目 ‹</span>
      </a>

      <nav class="nav">${navigation}</nav>

      <!-- 底部账号与安全区 (专属账号退出层级) -->
      <div class="sidebar-footer" style="padding-top:14px;border-top:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:space-between">
        <div class="user-chip" style="margin:0">
          <span class="avatar">${escapeHtml(initial)}</span>
          <div class="user-chip-text">
            <strong style="font-size:13px">${escapeHtml(account.display_name || account.username)}</strong>
            <span style="font-size:11px;color:rgba(255,255,255,0.5)">${escapeHtml(account.role || "user")}</span>
          </div>
        </div>
        <button class="button button-ghost button-small" id="logout-button" style="color:#f87171;border:1px solid rgba(248,113,113,0.3);padding:4px 10px;font-size:12px;white-space:nowrap" title="退出当前登录账号">
          退出登录
        </button>
      </div>
    </aside>
    <section class="workspace">
      <header class="topbar">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="button button-ghost mobile-menu" id="mobile-menu" aria-label="打开菜单">☰</button>
          <div class="breadcrumb"><strong>${escapeHtml(project.name)}</strong> / ${escapeHtml(navItems.find(([key]) => key === current)?.[1] || "项目")}</div>
        </div>
        <span class="badge badge-${escapeHtml(project.status)}">${project.status === "active" ? "运行中" : escapeHtml(project.status)}</span>
      </header>
      <div id="global-task-bar-container" class="global-floating-task-dock"></div>
      <main class="content">${content}</main>
    </section>
  </div>`;
}

function updateGlobalTaskWidget() {
  const container = document.querySelector("#global-task-bar-container");
  if (!container) return;
  const activeTasks = taskManager.getActiveTasks();
  if (!activeTasks.length) {
    container.innerHTML = "";
    return;
  }

  const activeTaskIds = new Set(activeTasks.map((t) => String(t.task_id)));

  // Remove finished task cards
  Array.from(container.children).forEach((child) => {
    const taskId = child.getAttribute("data-task-id");
    if (taskId && !activeTaskIds.has(taskId)) {
      child.remove();
    }
  });

  // Append or update active task cards in-place
  activeTasks.forEach((t) => {
    const safeId = String(t.task_id).replace(/[^a-zA-Z0-9_-]/g, "_");
    let card = container.querySelector(`[data-task-id="${t.task_id}"]`);
    if (!card) {
      card = document.createElement("div");
      card.setAttribute("data-task-id", t.task_id);
      card.className = "floating-task-card";
      card.style.cssText = "background:rgba(15,23,42,0.92);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.18);border-radius:14px;padding:12px 18px;min-width:320px;max-width:440px;color:#f8fafc;box-shadow:0 20px 35px -10px rgba(0,0,0,0.4),0 0 15px rgba(59,130,246,0.25);margin-bottom:8px";
      card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px">
          <div style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#60a5fa">
            <span style="width:8px;height:8px;border-radius:50%;background:#38bdf8;box-shadow:0 0 8px #38bdf8;display:inline-block"></span>
            <span>[后台隐式运行] ${t.type === 'architecture' ? '架构大模型抽取' : '日志与图谱 RCA'}</span>
          </div>
          <span id="floating-percent-${safeId}" style="font-family:monospace,Consolas;font-size:14px;font-weight:800;color:#38bdf8;background:rgba(56,189,248,0.15);padding:1px 8px;border-radius:8px;border:1px solid rgba(56,189,248,0.35)">${t.progress}%</span>
        </div>
        <div id="floating-msg-${safeId}" style="font-size:12px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:8px" title="${escapeHtml(t.progress_message || '处理中...')}">
          ⚡ ${escapeHtml(t.progress_message || '后台异步处理中...')}
        </div>
        <div style="width:100%;height:6px;background:rgba(255,255,255,0.12);border-radius:999px;overflow:hidden">
          <div id="floating-bar-${safeId}" style="width:${t.progress}%;height:100%;background:linear-gradient(90deg, #38bdf8, #818cf8);border-radius:999px;transition:width 0.4s ease;box-shadow:0 0 8px rgba(56,189,248,0.6)"></div>
        </div>
      `;
      container.appendChild(card);
    } else {
      // In-place update without re-creating DOM
      const pctEl = card.querySelector(`#floating-percent-${safeId}`);
      if (pctEl && pctEl.textContent !== `${t.progress}%`) {
        pctEl.textContent = `${t.progress}%`;
      }
      const msgEl = card.querySelector(`#floating-msg-${safeId}`);
      const newMsg = `⚡ ${t.progress_message || '后台异步处理中...'}`;
      if (msgEl && msgEl.textContent !== newMsg) {
        msgEl.textContent = newMsg;
        msgEl.title = t.progress_message || '处理中...';
      }
      const barEl = card.querySelector(`#floating-bar-${safeId}`);
      if (barEl) {
        barEl.style.width = `${t.progress}%`;
      }
    }
  });
}

let isShellBound = false;

export function bindShell({ onLogout }) {
  document.querySelector("#mobile-menu")?.addEventListener("click", () => {
    document.querySelector("#app-shell")?.classList.toggle("menu-open");
  });
  document.querySelector("#logout-button")?.addEventListener("click", onLogout);
  document.querySelectorAll(".nav-link").forEach((link) => link.addEventListener("click", () => {
    document.querySelector("#app-shell")?.classList.remove("menu-open");
  }));

  updateGlobalTaskWidget();
  if (!isShellBound) {
    taskManager.addEventListener("task:updated", updateGlobalTaskWidget);
    taskManager.addEventListener("task:completed", updateGlobalTaskWidget);
    isShellBound = true;
  }
}

