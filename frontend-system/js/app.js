import { hasSession, restoreSession, signOut, user } from "./auth.js";
import { navigate, onRouteChange, route } from "./router.js";
import { bindShell } from "./shell.js";
import { loadProject } from "./state.js";
import { errorState, loading, toast } from "./ui.js";
import { renderAuthPage } from "./pages/auth-page.js";
import { renderProjectsPage } from "./pages/projects-page.js";
import { renderOverviewPage } from "./pages/overview-page.js";
import { renderArchitecturePage } from "./pages/architecture-page.js";
import { renderLogsPage } from "./pages/logs-page.js";
import { renderIncidentsPage } from "./pages/incidents-page.js";
import { renderIncidentDetailPage } from "./pages/incident-detail-page.js";

const root = document.querySelector("#app");
let renderVersion = 0;

async function logout() {
  await signOut();
  navigate("/projects");
  render();
}

async function render(nextRoute = route()) {
  const version = ++renderVersion;
  if (!user()) {
    renderAuthPage(root, { onAuthenticated: () => { navigate("/projects"); render(); } });
    return;
  }

  if (nextRoute.name === "projects") {
    await renderProjectsPage(root, { onLogout: logout });
    return;
  }

  root.innerHTML = `<div class="state-panel" style="min-height:100vh">${loading("正在进入项目…")}</div>`;
  try {
    const project = await loadProject(nextRoute.params.projectId);
    if (version !== renderVersion) return;
    if (nextRoute.name === "overview") await renderOverviewPage(root, project);
    else if (nextRoute.name === "architecture") await renderArchitecturePage(root, project);
    else if (nextRoute.name === "logs") await renderLogsPage(root, project);
    else if (nextRoute.name === "incidents") await renderIncidentsPage(root, project);
    else if (nextRoute.name === "incident-detail") await renderIncidentDetailPage(root, project, nextRoute.params.incidentId);
    if (version === renderVersion) bindShell({ onLogout: logout });
  } catch (error) {
    if (version !== renderVersion) return;
    root.innerHTML = `<main class="content">${errorState(error, "back-projects")}</main>`;
    root.querySelector("#back-projects")?.addEventListener("click", () => navigate("/projects"));
  }
}

window.addEventListener("auth:expired", () => {
  toast("登录已失效，请重新登录", "error");
  render();
});

onRouteChange(render);

async function boot() {
  root.innerHTML = `<div class="state-panel" style="min-height:100vh"><span class="spinner"></span><p>正在恢复会话…</p></div>`;
  if (hasSession()) await restoreSession();
  await render();
}

boot();
