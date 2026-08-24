import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { cacheProject, loadProject } from "../utils/state.js";
import { taskManager } from "../tools/taskManager.js";
import { AppShell } from "../components/AppShell.jsx";
import { ErrorState, LoadingState } from "../components/Ui.jsx";
import { ArchitecturePage } from "./ArchitecturePage.jsx";
import { IncidentDetailPage } from "./IncidentDetailPage.jsx";
import { IncidentsPage } from "./IncidentsPage.jsx";
import { LogReportPage } from "./LogReportPage.jsx";
import { LogsPage } from "./LogsPage.jsx";
import { OverviewPage } from "./OverviewPage.jsx";
import { ProfileModal } from "./ProjectsPage.jsx";
import { ReportsPage } from "./ReportsPage.jsx";

const shellSection = (name) => name === "log-report" ? "reports" : name === "incident-detail" ? "incidents" : name;

function CurrentPage({ section, project, batchId, incidentId, onProjectUpdated }) {
  switch (section) {
    case "architecture": return <ArchitecturePage project={project} />;
    case "logs": return <LogsPage project={project} />;
    case "reports": return <ReportsPage project={project} />;
    case "log-report": return <LogReportPage project={project} batchId={batchId} />;
    case "incidents": return <IncidentsPage project={project} />;
    case "incident-detail": return <IncidentDetailPage project={project} incidentId={incidentId} />;
    case "overview":
    default: return <OverviewPage project={project} onProjectUpdated={onProjectUpdated} />;
  }
}

export function ProjectPage({ section, onLogout, account, onAccountUpdated }) {
  const { projectId, batchId, incidentId } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true, project: null, error: null });
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setState({ loading: true, project: null, error: null });
    loadProject(projectId)
      .then((project) => {
        if (!active) return;
        taskManager.setProject(project.id);
        setState({ loading: false, project, error: null });
      })
      .catch((error) => { if (active) setState({ loading: false, project: null, error }); });
    return () => { active = false; };
  }, [projectId]);

  const updateProject = (project) => {
    if (!project) return;
    cacheProject(project);
    setState((current) => ({ ...current, project }));
  };

  if (state.loading) return <LoadingState message="正在进入项目…" minHeight="100vh" />;
  if (state.error || !state.project) {
    return <main className="content"><ErrorState error={state.error || new Error("项目不存在")} onRetry={() => navigate("/projects")} /></main>;
  }

  return (
    <AppShell account={account} project={state.project} current={shellSection(section)} onLogout={onLogout} onProfile={() => setProfileOpen(true)}>
      <CurrentPage section={section} project={state.project} batchId={batchId} incidentId={incidentId} onProjectUpdated={updateProject} />
      {profileOpen ? <ProfileModal account={account} onClose={() => setProfileOpen(false)} onUpdated={onAccountUpdated} /> : null}
    </AppShell>
  );
}
