import React, { useMemo } from "react";
import { Avatar, Button, Nav, Tooltip } from "@douyinfe/semi-ui";
import { IconChevronDown, IconExit } from "@douyinfe/semi-icons";
import { Link } from "react-router-dom";
import { APP_VERSION } from "../utils/config.js";
import { buildNavigationModel } from "../routes/navigation.js";
import { Icons } from "./Icons.jsx";

export function Sidebar({ account, project = null, current = "projects", onLogout, onProfile, onNavigate }) {
  const initial = (account?.display_name || account?.username || "U").slice(0, 1).toUpperCase();
  const model = buildNavigationModel({ project, current, isAdmin: account?.role === "admin" });
  const itemMap = useMemo(
    () => new Map(model.flatMap((section) => section.items).map((item) => [item.key, item])),
    [model],
  );

  return (
    <aside className="sidebar">
      <Link className="brand" to="/projects">
        <span className="brand-mark">L</span>
        <span>LogScope RCA <small className="brand-version">{APP_VERSION}</small></span>
      </Link>

      <Link
        className="project-switcher sidebar-context"
        to="/projects"
        title={project ? "切换当前项目" : "选择一个项目"}
        onClick={onNavigate}
      >
        <div><small>{project ? "当前项目" : "当前范围"}</small><strong>{project?.name || "全部项目"}</strong></div>
        <span>{project ? "切换" : "选择"}</span>
      </Link>

      <div className="sidebar-navigation" aria-label="主导航">
        <Nav
          mode="vertical"
          selectedKeys={[current]}
          className="sidebar-semi-nav"
          bodyStyle={{ padding: 0, background: "transparent" }}
          renderWrapper={({ itemElement, props }) => {
            const item = itemMap.get(props?.itemKey);
            if (!item || item.disabled || !item.to) return itemElement;
            return <Link className="sidebar-nav-router-link" to={item.to} onClick={onNavigate}>{itemElement}</Link>;
          }}
        >
          {model.map((section) => {
            const projectExpanded = section.key !== "project" || Boolean(project?.id);
            return (
              <React.Fragment key={section.key}>
                <div
                  className={[
                    "semi-nav-section-title",
                    section.active ? "active" : "",
                    section.key === "project" ? (projectExpanded ? "expanded" : "collapsed") : "",
                  ].filter(Boolean).join(" ")}
                >
                  <span>{section.label}</span>
                  {section.hint ? <small title={section.hint}>{section.hint}</small> : null}
                  {section.key === "project" ? <span className="semi-nav-section-chevron" aria-hidden="true"><IconChevronDown size="small" /></span> : null}
                </div>
                {projectExpanded ? section.items.map((item) => (
                  <Nav.Item
                    key={item.key}
                    itemKey={item.key}
                    text={item.label}
                    icon={Icons[item.key]}
                    disabled={item.disabled}
                  />
                )) : null}
              </React.Fragment>
            );
          })}
        </Nav>
      </div>

      <div className="sidebar-footer">
        <Tooltip content={onProfile ? "点击修改个人资料与密码" : undefined}>
          <div className="user-chip" onClick={onProfile} style={{ cursor: onProfile ? "pointer" : undefined }}>
            <Avatar size="small" className="avatar">{initial}</Avatar>
            <div className="user-chip-text">
              <strong>{account?.display_name || account?.username}</strong>
              <span>{account?.role || "user"}</span>
            </div>
          </div>
        </Tooltip>
        <Button
          theme="borderless"
          type="danger"
          size="small"
          icon={<IconExit />}
          onClick={onLogout}
          className="sidebar-logout"
          aria-label="退出当前登录账号"
        >
          退出登录
        </Button>
      </div>
    </aside>
  );
}
