import { useEffect, useState } from "react";
import { taskManager } from "../tools/taskManager.js";

export function useActiveTasks() {
  const [tasks, setTasks] = useState(() => taskManager.getActiveTasks().slice());

  useEffect(() => {
    const update = () => setTasks(taskManager.getActiveTasks().slice());
    taskManager.addEventListener("task:updated", update);
    taskManager.addEventListener("task:completed", update);
    update();
    return () => {
      taskManager.removeEventListener("task:updated", update);
      taskManager.removeEventListener("task:completed", update);
    };
  }, []);

  return tasks;
}
