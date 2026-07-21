import { API_BASE } from "./config.js";

const TOKEN_KEY = "logscope_token";

export class ApiError extends Error {
  constructor(message, status, data = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const body = options.body;
  if (body && !(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch (error) {
    throw new ApiError(`无法连接后端 ${API_BASE}，请确认 FastAPI 已启动`, 0, error);
  }

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401) {
      setToken("");
      window.dispatchEvent(new CustomEvent("auth:expired"));
    }
    const detail = typeof data === "object" ? data.detail : data;
    const message = Array.isArray(detail)
      ? detail.map((item) => item.msg || JSON.stringify(item)).join("；")
      : detail || `请求失败（${response.status}）`;
    throw new ApiError(String(message), response.status, data);
  }
  return data;
}

export const api = {
  register: (payload) => request("/auth/register", { method: "POST", body: JSON.stringify(payload) }),
  login: (payload) => request("/auth/login", { method: "POST", body: JSON.stringify(payload) }),
  me: () => request("/auth/me"),
  logout: () => request("/auth/logout", { method: "POST" }),

  projects: (archived = false) => request(`/projects?include_archived=${archived}`),
  project: (id) => request(`/projects/${id}`),
  createProject: (payload) => request("/projects", { method: "POST", body: JSON.stringify(payload) }),
  updateProject: (id, payload) => request(`/projects/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  archiveProject: (id) => request(`/projects/${id}`, { method: "DELETE" }),
  dashboard: (id) => request(`/projects/${id}/dashboard`),

  architectures: (id) => request(`/projects/${id}/architectures`),
  importArchitecture: (id, form) => request(`/projects/${id}/architectures/import`, { method: "POST", body: form }),
  graph: (id) => request(`/projects/${id}/graph`),
  createNode: (id, payload) => request(`/projects/${id}/graph/nodes`, { method: "POST", body: JSON.stringify(payload) }),
  updateNode: (id, name, payload) => request(`/projects/${id}/graph/nodes/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteNode: (id, name) => request(`/projects/${id}/graph/nodes/${encodeURIComponent(name)}`, { method: "DELETE" }),
  createEdge: (id, payload) => request(`/projects/${id}/graph/edges`, { method: "POST", body: JSON.stringify(payload) }),
  updateEdge: (id, payload) => request(`/projects/${id}/graph/edges`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteEdge: (id, payload) => request(`/projects/${id}/graph/edges/delete`, { method: "POST", body: JSON.stringify(payload) }),

  logs: (id) => request(`/projects/${id}/logs`),
  analyzeLogs: (id, form) => request(`/projects/${id}/logs/analyze`, { method: "POST", body: form }),
  batch: (projectId, batchId) => request(`/projects/${projectId}/logs/${batchId}`),
  deleteBatch: (projectId, batchId) => request(`/projects/${projectId}/logs/${batchId}`, { method: "DELETE" }),

  incidents: (id, filters = {}) => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.severity) params.set("severity", filters.severity);
    const query = params.toString();
    return request(`/projects/${id}/incidents${query ? `?${query}` : ""}`);
  },
  incident: (projectId, incidentId) => request(`/projects/${projectId}/incidents/${incidentId}`),
  incidentGraph: (projectId, incidentId, includeEvents = false) => request(`/projects/${projectId}/incidents/${incidentId}/graph?include_events=${includeEvents}&event_limit=30`),
  updateIncidentStatus: (projectId, incidentId, payload) => request(`/projects/${projectId}/incidents/${incidentId}/status`, { method: "PATCH", body: JSON.stringify(payload) }),
};
