const ICONS = {
  projects: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`,
  overview: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>`,
  architecture: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 7l4 9M17 7l-4 9M7 6h10"/></svg>`,
  logs: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  incidents: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  reports: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/><path d="M3 4l5-2 5 2 6-3"/></svg>`,
  users: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg>`,
  graph: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 7l4 9M17 7l-4 9M7 6h10"/></svg>`,
};

const PROJECT_ITEMS = [
  ["overview", "项目总览"],
  ["architecture", "系统架构拓扑"],
  ["logs", "日志解析检测"],
  ["incidents", "故障根因定位"],
  ["reports", "综合分析报告"],
];

let previousNavigationScope = "";

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function buildNavigationModel({ project = null, current = "projects", isAdmin = false } = {}) {
  const projectId = project?.id ? encodeURIComponent(project.id) : "";
  const sections = [
    {
      key: "workspace",
      label: "项目空间",
      items: [{ key: "projects", label: "项目列表", href: "#/projects", disabled: false }],
    },
    {
      key: "project",
      label: "项目工作台",
      hint: project ? project.name : "请先选择项目",
      items: PROJECT_ITEMS.map(([key, label]) => ({
        key,
        label,
        href: projectId ? `#/projects/${projectId}/${key}` : "",
        disabled: !projectId,
      })),
    },
  ];
  if (isAdmin) {
    sections.push({
      key: "system",
      label: "系统管理",
      items: [
        { key: "users", label: "用户与权限管理", href: "#/projects?tab=users", disabled: false },
        { key: "graph", label: "图谱管理", href: "#/projects?tab=graph", disabled: false },
      ],
    });
  }
  return sections.map((section) => ({
    ...section,
    active: section.items.some((item) => item.key === current),
    items: section.items.map((item) => ({ ...item, active: item.key === current })),
  }));
}

export function renderSidebarNavigation(options = {}) {
  const hasProject = Boolean(options.project?.id);
  const currentScope = hasProject ? "project" : ["users", "graph"].includes(options.current) ? "system" : "workspace";
  const animateProjectEntry = hasProject && previousNavigationScope !== "project";
  previousNavigationScope = currentScope;
  return buildNavigationModel(options).map((section) => {
    const projectExpanded = section.key === "project" && hasProject;
    const sectionClasses = [
      "nav-section",
      `nav-section-${section.key}`,
      section.active ? "active" : "",
      section.key === "project" ? (projectExpanded ? "nav-section-expanded" : "nav-section-collapsed") : "",
      projectExpanded && animateProjectEntry ? "nav-section-entering" : "",
    ].filter(Boolean).join(" ");
    return `
    <section class="${sectionClasses}" data-section="${section.key}">
      <div class="nav-section-title"><span>${escapeHtml(section.label)}</span>${section.hint ? `<small>${escapeHtml(section.hint)}</small>` : ""}${section.key === "project" ? '<i class="nav-section-chevron" aria-hidden="true">⌄</i>' : ""}</div>
      <div class="nav-section-body" ${section.key === "project" && !projectExpanded ? 'aria-hidden="true"' : ""}>
      <div class="nav nav-secondary">
        ${section.items.map((item) => {
          const body = `<span class="nav-icon">${ICONS[item.key] || ""}</span><span>${escapeHtml(item.label)}</span>`;
          if (item.disabled) return `<span class="nav-link nav-link-disabled" aria-disabled="true" title="请先从项目列表中选择一个项目">${body}</span>`;
          return `<a class="nav-link ${item.active ? "active" : ""}" href="${item.href}" data-nav-section="${section.key}" ${item.active ? 'aria-current="page"' : ""}>${body}</a>`;
        }).join("")}
      </div>
      </div>
    </section>
  `;
  }).join("");
}

export function renderSidebarContext(project = null) {
  return `<a class="project-switcher sidebar-context" href="#/projects" data-nav-section="workspace" title="${project ? "切换当前项目" : "选择一个项目"}">
    <div>
      <small>${project ? "当前项目" : "当前范围"}</small>
      <strong>${escapeHtml(project?.name || "全部项目")}</strong>
    </div>
    <span>${project ? "切换" : "选择"}</span>
  </a>`;
}

export function bindNavigationTransitions(root = document) {
  const projectSection = root.querySelector(".nav-section-project.nav-section-expanded");
  if (!projectSection) return;
  root.querySelectorAll('a[data-nav-section]:not([data-nav-section="project"])').forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const href = link.getAttribute("href") || "";
      if (!href.startsWith("#")) return;
      event.preventDefault();
      projectSection.classList.remove("nav-section-entering");
      projectSection.classList.add("is-collapsing");
      window.setTimeout(() => {
        window.location.hash = href.slice(1);
      }, 190);
    });
  });
}
