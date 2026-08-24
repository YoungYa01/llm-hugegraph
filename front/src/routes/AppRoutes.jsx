import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthPage } from "../pages/AuthPage.jsx";
import { ProjectPage } from "../pages/ProjectPage.jsx";
import { ProjectsPage } from "../pages/ProjectsPage.jsx";

function RequireAuth({ account, children }) {
  return account ? children : <Navigate to="/login" replace />;
}

export function AppRoutes({ account, onAuthenticated, onLogout, onAccountUpdated }) {
  return (
    <Routes>
      <Route path="/login" element={account ? <Navigate to="/projects" replace /> : <AuthPage onAuthenticated={onAuthenticated} />} />
      <Route path="/projects" element={<RequireAuth account={account}><ProjectsPage account={account} onLogout={onLogout} onAccountUpdated={onAccountUpdated} /></RequireAuth>} />
      <Route path="/projects/:projectId/overview" element={<RequireAuth account={account}><ProjectPage section="overview" account={account} onLogout={onLogout} onAccountUpdated={onAccountUpdated} /></RequireAuth>} />
      <Route path="/projects/:projectId/architecture" element={<RequireAuth account={account}><ProjectPage section="architecture" account={account} onLogout={onLogout} onAccountUpdated={onAccountUpdated} /></RequireAuth>} />
      <Route path="/projects/:projectId/logs" element={<RequireAuth account={account}><ProjectPage section="logs" account={account} onLogout={onLogout} onAccountUpdated={onAccountUpdated} /></RequireAuth>} />
      <Route path="/projects/:projectId/incidents" element={<RequireAuth account={account}><ProjectPage section="incidents" account={account} onLogout={onLogout} onAccountUpdated={onAccountUpdated} /></RequireAuth>} />
      <Route path="/projects/:projectId/incidents/:incidentId" element={<RequireAuth account={account}><ProjectPage section="incident-detail" account={account} onLogout={onLogout} onAccountUpdated={onAccountUpdated} /></RequireAuth>} />
      <Route path="/projects/:projectId/reports" element={<RequireAuth account={account}><ProjectPage section="reports" account={account} onLogout={onLogout} onAccountUpdated={onAccountUpdated} /></RequireAuth>} />
      <Route path="/projects/:projectId/reports/:batchId" element={<RequireAuth account={account}><ProjectPage section="log-report" account={account} onLogout={onLogout} onAccountUpdated={onAccountUpdated} /></RequireAuth>} />
      <Route path="*" element={<Navigate to={account ? "/projects" : "/login"} replace />} />
    </Routes>
  );
}
