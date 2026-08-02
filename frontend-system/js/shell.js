import { user } from "./auth.js";
import { APP_VERSION } from "./config.js";
import { escapeHtml } from "./ui.js";

const icons = {
  overview: "⌂",
  architecture: "⬡",
  logs: "≋",
  incidents: "!",
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
      <main class="content">${content}</main>
    </section>
  </div>`;
}

export function bindShell({ onLogout }) {
  document.querySelector("#mobile-menu")?.addEventListener("click", () => {
    document.querySelector("#app-shell")?.classList.toggle("menu-open");
  });
  document.querySelector("#logout-button")?.addEventListener("click", onLogout);
  document.querySelectorAll(".nav-link").forEach((link) => link.addEventListener("click", () => {
    document.querySelector("#app-shell")?.classList.remove("menu-open");
  }));
}
