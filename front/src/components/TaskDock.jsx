import React from "react";
import { Progress, Tag } from "@douyinfe/semi-ui";
import { IconLightningStroked } from "@douyinfe/semi-icons";
import { useActiveTasks } from "../hooks/useActiveTasks.js";

export function TaskDock() {
  const tasks = useActiveTasks();
  return <div className="global-floating-task-dock">{tasks.map((t) => <div key={t.task_id} className="floating-task-card" style={{ background: "rgba(15,23,42,0.92)", backdropFilter: "blur(16px)", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 14, padding: "12px 18px", minWidth: 320, maxWidth: 440, color: "#f8fafc", boxShadow: "0 20px 35px -10px rgba(0,0,0,0.4),0 0 15px rgba(59,130,246,0.25)", marginBottom: 8 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}><div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "#60a5fa" }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: "#38bdf8", boxShadow: "0 0 8px #38bdf8", display: "inline-block" }} /><span>[后台隐式运行] {t.type === "architecture" ? "架构大模型抽取" : "日志与图谱 RCA"}</span></div><Tag size="small" color="blue" className="task-progress-tag">{t.progress || 0}%</Tag></div>
    <div className="task-progress-copy"><IconLightningStroked size="small" /> <span>{t.progress_message || "后台异步处理中..."}</span></div>
    <Progress percent={t.progress || 0} showInfo={false} stroke="var(--semi-color-primary)" className="task-progress-bar" />
  </div>)}</div>;
}
