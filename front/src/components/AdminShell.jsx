import React, { useState } from "react";
import { Button } from "@douyinfe/semi-ui";
import { IconMenu, IconSetting } from "@douyinfe/semi-icons";
import { Sidebar } from "./Sidebar.jsx";

const titles = { projects: "项目空间", users: "用户与权限管理", graph: "图谱管理" };

export function AdminShell({ account, current, onLogout, onProfile, children }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <div className={`app-shell${menuOpen ? " menu-open" : ""}`} id="app-shell"><Sidebar account={account} current={current} onLogout={onLogout} onProfile={onProfile} onNavigate={() => setMenuOpen(false)} />
    <section className="workspace"><header className="topbar"><div style={{ display: "flex", alignItems: "center", gap: 10 }}><Button className="mobile-menu" theme="borderless" type="tertiary" icon={<IconMenu />} aria-label="打开菜单" onClick={() => setMenuOpen((v) => !v)} /><span style={{ fontSize: 14, fontWeight: 700, color: "var(--ink-900)" }}>{titles[current]}</span></div><div style={{ display: "flex", alignItems: "center", gap: 12 }}><span style={{ fontSize: 12, color: "var(--ink-500)" }}>当前用户: <strong style={{ color: "var(--ink-800)" }}>{account?.display_name || account?.username}</strong></span><Button theme="light" type="tertiary" size="small" icon={<IconSetting />} onClick={onProfile} className="button button-secondary button-small">个人设置</Button></div></header><main className="content">{children}</main></section>
  </div>;
}
