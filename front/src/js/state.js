import { api } from "./api.js";

const projects = new Map();
const LOG_TASK_KEY = "logscope_log_tasks";
const logTaskListeners = new Set();
let logTaskTimer = 0;

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

function readLogTasks() {
  try {
    const data = JSON.parse(localStorage.getItem(LOG_TASK_KEY) || "[]");
    return Array.isArray(data) ? data.filter((item) => item?.projectId && item?.batchId) : [];
  } catch {
    return [];
  }
}

function writeLogTasks(tasks) {
  localStorage.setItem(LOG_TASK_KEY, JSON.stringify(tasks));
  window.dispatchEvent(new CustomEvent("log-tasks:changed", { detail: { tasks } }));
  logTaskListeners.forEach((listener) => listener(tasks));
}

export function getLogTasks(projectId = "") {
  const tasks = readLogTasks();
  return projectId ? tasks.filter((task) => task.projectId === projectId) : tasks;
}

export function rememberLogTask(task) {
  const tasks = readLogTasks().filter((item) => !(item.projectId === task.projectId && item.batchId === task.batchId));
  tasks.push({ ...task, updatedAt: new Date().toISOString() });
  writeLogTasks(tasks);
  startLogTaskPolling();
}

export function onLogTasksChanged(listener) {
  logTaskListeners.add(listener);
  return () => logTaskListeners.delete(listener);
}

export function startLogTaskPolling() {
  if (logTaskTimer) return;
  async function tick() {
    const tasks = readLogTasks();
    if (!tasks.length) {
      clearInterval(logTaskTimer);
      logTaskTimer = 0;
      return;
    }
    const next = [];
    for (const task of tasks) {
      try {
        const data = await api.batch(task.projectId, task.batchId);
        const batch = data.batch;
        const status = batch?.status || task.status;
        if ((task.type === "analyze" && status === "completed") || status === "failed") {
          window.dispatchEvent(new CustomEvent("log-task:finished", { detail: { task: { ...task, batch, status } } }));
          continue;
        }
        next.push({ ...task, status, summary: batch?.summary || task.summary || {}, batch, updatedAt: new Date().toISOString() });
      } catch (error) {
        if (task.type === "delete" && error.status === 404) {
          window.dispatchEvent(new CustomEvent("log-task:finished", { detail: { task: { ...task, status: "completed" } } }));
          continue;
        }
        next.push({ ...task, error: error.message, updatedAt: new Date().toISOString() });
      }
    }
    writeLogTasks(next);
  }
  tick();
  logTaskTimer = window.setInterval(tick, 2200);
}
