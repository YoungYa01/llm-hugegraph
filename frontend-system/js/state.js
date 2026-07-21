import { api } from "./api.js";

const projects = new Map();

export async function loadProject(id, refresh = false) {
  if (!refresh && projects.has(id)) return projects.get(id);
  const data = await api.project(id);
  projects.set(id, data.project);
  return data.project;
}

export function cacheProject(project) {
  if (project?.id) projects.set(project.id, project);
}

export function forgetProject(id) {
  projects.delete(id);
}
