import React, { useState } from "react";
import { Button, Tag } from "@douyinfe/semi-ui";
import { IconMenu } from "@douyinfe/semi-icons";
import { Sidebar } from "./Sidebar.jsx";
import { TaskDock } from "./TaskDock.jsx";

const navLabels = { overview: "项目总览", architecture: "系统架构拓扑", logs: "日志解析检测", incidents: "故障根因定位", reports: "综合分析报告" };

export function AppShell({ account, project, current, onLogout, onProfile, children }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <div className={`app-shell${menuOpen ? " menu-open" : ""}`} id="app-shell">
    <Sidebar account={account} project={project} current={current} onLogout={onLogout} onProfile={onProfile} onNavigate={() => setMenuOpen(false)} />
    <section className="workspace">
      <header className="topbar"><div style={{ display: "flex", alignItems: "center", gap: 10 }}><Button className="mobile-menu" theme="borderless" type="tertiary" icon={<IconMenu />} aria-label="打开菜单" onClick={() => setMenuOpen((v) => !v)} /><div className="breadcrumb">项目工作台 / <strong>{project.name}</strong> / {navLabels[current] || "项目"}</div></div><Tag className={`badge badge-${project.status}`}>{project.status === "active" ? "运行中" : project.status}</Tag></header>
      <TaskDock />
      <main className="content">{children}</main>
    </section>
  </div>;
}
