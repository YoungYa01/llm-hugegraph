export const paths = {
  login: () => "/login",
  projects: (tab = "") => tab ? `/projects?tab=${encodeURIComponent(tab)}` : "/projects",
  project: (projectId, section = "overview") => `/projects/${encodeURIComponent(projectId)}/${section}`,
  overview: (projectId) => `/projects/${encodeURIComponent(projectId)}/overview`,
  architecture: (projectId) => `/projects/${encodeURIComponent(projectId)}/architecture`,
  logs: (projectId) => `/projects/${encodeURIComponent(projectId)}/logs`,
  incidents: (projectId, query = {}) => {
    const search = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
    });
    const suffix = search.toString();
    return `/projects/${encodeURIComponent(projectId)}/incidents${suffix ? `?${suffix}` : ""}`;
  },
  incident: (projectId, incidentId, query = {}) => {
    const search = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
    });
    const suffix = search.toString();
    return `/projects/${encodeURIComponent(projectId)}/incidents/${encodeURIComponent(incidentId)}${suffix ? `?${suffix}` : ""}`;
  },
  reports: (projectId) => `/projects/${encodeURIComponent(projectId)}/reports`,
  report: (projectId, batchId) => `/projects/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(batchId)}`,
};
