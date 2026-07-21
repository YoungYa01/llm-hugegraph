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
  ["architecture", "架构图谱"],
  ["logs", "日志数据"],
  ["incidents", "故障与根因"],
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
      <a class="project-switcher" href="#/projects" title="切换项目">
        <small>当前项目 · 点击切换</small><strong>${escapeHtml(project.name)}</strong>
      </a>
      <nav class="nav">${navigation}</nav>
      <div class="sidebar-footer">
        <div class="user-chip">
          <span class="avatar">${escapeHtml(initial)}</span>
          <div class="user-chip-text"><strong>${escapeHtml(account.display_name || account.username)}</strong><span>${escapeHtml(account.role || "user")}</span></div>
        </div>
        <div class="sidebar-actions">
          <a class="button button-ghost button-small" href="#/projects">所有项目</a>
          <button class="button button-ghost button-small" id="logout-button">退出</button>
        </div>
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
