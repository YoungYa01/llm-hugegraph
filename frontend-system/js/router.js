const listeners = new Set();

export function route() {
  const raw = location.hash.replace(/^#/, "") || "/projects";
  const path = raw.split("?")[0];
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "projects") return { name: "projects", params: {} };
  if (!parts[1]) return { name: "projects", params: {} };
  const params = { projectId: parts[1] };
  if (!parts[2] || parts[2] === "overview") return { name: "overview", params };
  if (parts[2] === "architecture") return { name: "architecture", params };
  if (parts[2] === "logs") return { name: "logs", params };
  if (parts[2] === "incidents" && parts[3]) return { name: "incident-detail", params: { ...params, incidentId: parts[3] } };
  if (parts[2] === "incidents") return { name: "incidents", params };
  return { name: "overview", params };
}

export function navigate(path) {
  location.hash = path.startsWith("/") ? path : `/${path}`;
}

export function onRouteChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

window.addEventListener("hashchange", () => listeners.forEach((listener) => listener(route())));
