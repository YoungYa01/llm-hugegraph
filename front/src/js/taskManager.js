import { api } from "./api.js";
import { toast } from "./ui.js";

class TaskManager extends EventTarget {
  constructor() {
    super();
    this.currentProjectId = null;
    this.activeTasks = [];
    this.knownTaskStatuses = new Map(); // taskId -> lastTask
    this.timerId = null;
    this.isPolling = false;
  }

  setProject(projectId) {
    if (this.currentProjectId === projectId) {
      this.pollNow();
      return;
    }
    this.currentProjectId = projectId;
    this.activeTasks = [];
    this.knownTaskStatuses.clear();
    this.pollNow();
  }

  startPolling() {
    if (this.timerId) return;
    this.timerId = setInterval(() => this.pollNow(), 1500);
  }

  stopPolling() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  async pollNow() {
    if (!this.currentProjectId || this.isPolling) return;
    this.isPolling = true;
    try {
      const res = await api.activeTasks(this.currentProjectId);
      const latestTasks = res.active_tasks || [];

      // Check finished tasks
      const latestTaskIds = new Set(latestTasks.map((t) => t.task_id));

      for (const [taskId, oldTask] of this.knownTaskStatuses.entries()) {
        if (!latestTaskIds.has(taskId)) {
          this.knownTaskStatuses.delete(taskId);
          this.dispatchEvent(new CustomEvent("task:completed", { detail: oldTask }));
          toast(`后台任务【${oldTask.task_name}】处理完成！`, "success");
        }
      }

      // Check if state changed
      const oldState = JSON.stringify(this.activeTasks);
      const newState = JSON.stringify(latestTasks);

      this.activeTasks = latestTasks;
      for (const task of latestTasks) {
        this.knownTaskStatuses.set(task.task_id, task);
      }

      if (oldState !== newState) {
        this.dispatchEvent(new CustomEvent("task:updated", { detail: this.activeTasks }));
      }

      if (this.activeTasks.length > 0) {
        this.startPolling();
      } else {
        this.stopPolling();
      }
    } catch (error) {
      console.warn("Polling active tasks warning:", error);
    } finally {
      this.isPolling = false;
    }
  }

  getActiveTasks() {
    return this.activeTasks;
  }

  hasActiveTask(type = null) {
    if (!type) return this.activeTasks.length > 0;
    return this.activeTasks.some((t) => t.type === type);
  }

  getTaskByType(type) {
    return this.activeTasks.find((t) => t.type === type) || null;
  }
}

export const taskManager = new TaskManager();
