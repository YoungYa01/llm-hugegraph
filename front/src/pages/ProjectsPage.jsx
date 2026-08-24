import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar, Button, Card, Input, Modal as SemiModal, Select, Table, Tag } from "@douyinfe/semi-ui";
import { IconChevronRight, IconDeleteStroked, IconEditStroked, IconPlus, IconSearch, IconSetting } from "@douyinfe/semi-icons";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../utils/api.js";
import { setUser } from "../utils/auth.js";
import { cacheProject } from "../utils/state.js";
import { formatDate, toast } from "../utils/ui.js";
import { paths } from "../routes/paths.js";
import { AdminShell } from "../components/AdminShell.jsx";
import { ProjectModal } from "../components/ProjectModal.jsx";
import { EmptyState, ErrorState, LoadingState, Modal } from "../components/Ui.jsx";
import { GraphAdminPage } from "./GraphAdminPage.jsx";

const roleOptions = [{ value: "user", label: "普通用户" }, { value: "admin", label: "管理员" }];
const activeOptions = [{ value: "1", label: "正常启用" }, { value: "0", label: "停用" }];

export function ProfileModal({ account, onClose, onUpdated }) {
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState({
    display_name: account.display_name || account.username || "",
    employee_id: account.employee_id || "",
    old_password: "",
    new_password: "",
  });
  const patch = (key, value) => setValues((current) => ({ ...current, [key]: value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const res = await api.updateProfile(values);
      setUser(res.user);
      toast("个人账号信息已成功修改");
      onUpdated?.(res.user);
      onClose();
    } catch (error) {
      toast(error.message, "error");
      setBusy(false);
    }
  }

  return <Modal title={<span style={{ display: "flex", alignItems: "center", gap: 6 }}><IconSetting /> 个人账号设置</span>} onClose={onClose} maxWidth={440}>
    <form className="form-stack" onSubmit={submit}>
      <div className="field"><label>登录用户名</label><Input className="input" value={account.username || ""} disabled /><span className="field-hint">用户名用于登录验证，不可修改</span></div>
      <div className="field"><label>显示姓名 / 团队称呼</label><Input className="input" value={values.display_name} maxLength={120} onChange={(value) => patch("display_name", value)} /></div>
      <div className="field"><label>工号</label><Input className="input" value={values.employee_id} maxLength={64} onChange={(value) => patch("employee_id", value)} /><span className="field-hint">远程大模型请求将使用该工号作为 X-Ai-Coding-Key</span></div>
      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "14px 0" }} />
      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-800)", display: "block", marginBottom: 8 }}>修改密码 (不填写则保持原密码不变)</span>
      <div className="field"><label>当前旧密码</label><Input className="input" mode="password" value={values.old_password} placeholder="若要更新密码，请输入旧密码" onChange={(value) => patch("old_password", value)} /></div>
      <div className="field"><label>新密码</label><Input className="input" mode="password" value={values.new_password} placeholder="包含至少 4 位字符" onChange={(value) => patch("new_password", value)} /></div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 9, marginTop: 16 }}><Button className="button button-secondary" onClick={onClose}>取消</Button><Button className="button button-primary" htmlType="submit" theme="solid" type="primary" loading={busy}>保存修改</Button></div>
    </form>
  </Modal>;
}

function AdminEditUserModal({ targetUser, onClose, onUpdated }) {
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState({
    display_name: targetUser.display_name || targetUser.username,
    employee_id: targetUser.employee_id || "",
    role: targetUser.role,
    is_active: targetUser.is_active ? "1" : "0",
    new_password: "",
  });
  const patch = (key, value) => setValues((current) => ({ ...current, [key]: value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.updateUser(targetUser.id, { ...values, is_active: Number(values.is_active) });
      toast(`用户“${targetUser.username}”的信息已更新`);
      onClose();
      await onUpdated();
    } catch (error) {
      toast(error.message, "error");
      setBusy(false);
    }
  }

  return <Modal title={<span style={{ display: "flex", alignItems: "center", gap: 6 }}><IconEditStroked /> 编辑账号：{targetUser.username}</span>} onClose={onClose} maxWidth={440}>
    <form className="form-stack" onSubmit={submit}>
      <div className="field"><label>登录用户名</label><Input className="input" value={targetUser.username} disabled /></div>
      <div className="field"><label>显示姓名 / 团队称呼</label><Input className="input" value={values.display_name} onChange={(value) => patch("display_name", value)} /></div>
      <div className="field"><label>工号</label><Input className="input" value={values.employee_id} maxLength={64} onChange={(value) => patch("employee_id", value)} /></div>
      <div className="field"><label>账号角色</label><Select className="select" value={values.role} optionList={roleOptions} onChange={(value) => patch("role", value)} /></div>
      <div className="field"><label>账号状态</label><Select className="select" value={values.is_active} optionList={activeOptions} disabled={targetUser.role === "admin"} onChange={(value) => patch("is_active", value)} />{targetUser.role === "admin" ? <span className="field-hint" style={{ color: "var(--danger)" }}>管理员账号受系统保护，不可被停用</span> : null}</div>
      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "14px 0" }} />
      <div className="field"><label>重置新密码 (可选)</label><Input className="input" mode="password" value={values.new_password} placeholder="若无需重置，留空即可" onChange={(value) => patch("new_password", value)} /><span className="field-hint">管理员可以直接为此用户设置新密码，无需原密码</span></div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 9, marginTop: 16 }}><Button className="button button-secondary" onClick={onClose}>取消</Button><Button className="button button-primary" htmlType="submit" theme="solid" type="primary" loading={busy}>保存修改</Button></div>
    </form>
  </Modal>;
}

function ProjectStatus({ status }) {
  const label = status === "paused" ? "已暂停" : status === "archived" ? "已归档" : "正常运行";
  return <Tag className={`badge badge-${status === "active" ? "resolved" : status}`}>{label}</Tag>;
}

function ProjectsTab({ isAdmin }) {
  const [state, setState] = useState({ loading: true, items: [], error: null });
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState(null);
  const [deleting, setDeleting] = useState("");

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const { items } = await api.projects();
      items.forEach(cacheProject);
      setState({ loading: false, items, error: null });
    } catch (error) {
      setState({ loading: false, items: [], error });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return state.items;
    return state.items.filter((p) => [p.name, p.description, p.owner_name, p.owner_display_name].some((value) => String(value || "").toLowerCase().includes(q)));
  }, [query, state.items]);

  async function remove(project) {
    setDeleting(project.id);
    try {
      await api.deleteProject(project.id);
      toast(`项目“${project.name}”已永久删除`);
      await load();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setDeleting("");
    }
  }

  function confirmRemove(project) {
    SemiModal.confirm({
      title: "永久删除项目",
      content: `确定要永久删除项目“${project.name}”吗？该项目下的所有架构拓扑、日志检测批次、故障记录与 RCA 图谱节点将被一并永久清除，且无法撤销。`,
      okText: "永久删除",
      cancelText: "取消",
      okType: "danger",
      onOk: () => remove(project),
    });
  }

  return <>
    <div className="page-header" style={{ marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
      <div><h1 style={{ margin: "0 0 4px 0" }}>项目空间</h1><p style={{ margin: 0 }}>{isAdmin ? "管理员权限：全站所有用户的项目空间及架构数据全景。" : "每个项目拥有独立的架构图谱、日志批次和故障处理记录。"}</p></div>
      <div className="projects-toolbar" style={{ display: "flex", alignItems: "center", gap: 10 }}><Input className="input project-search-input" value={query} onChange={setQuery} showClear prefix={<IconSearch />} placeholder="搜索项目名称或描述..." style={{ width: 260 }} /><Button className="button button-primary" theme="solid" type="primary" icon={<IconPlus />} onClick={() => setModal({ project: null })}>新建项目</Button></div>
    </div>

    {state.loading ? <LoadingState message="正在拉取项目列表…" /> : state.error ? <ErrorState error={state.error} onRetry={load} /> : !state.items.length ? <EmptyState title="还没有项目" detail="先创建一个项目，再导入该系统的架构描述。"><Button className="button button-primary" theme="solid" type="primary" icon={<IconPlus />} onClick={() => setModal({ project: null })}>创建第一个项目</Button></EmptyState> : !filtered.length ? <EmptyState title="未找到匹配的项目" detail="尝试使用其他搜索关键词，或清除搜索框内容。"><Button className="button button-secondary button-small" onClick={() => setQuery("")}>重置搜索</Button></EmptyState> : <div className="grid grid-3">
      {filtered.map((project) => <Card key={project.id} className="card project-card semi-project-card" bodyStyle={{ padding: 18 }}>
        <div style={{ display: "flex", flexDirection: "column", minHeight: 145, justifyContent: "space-between" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 8 }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Avatar className="project-symbol">{project.name.slice(0, 1).toUpperCase()}</Avatar><ProjectStatus status={project.status} /></div><div style={{ display: "flex", gap: 6 }}><Button size="small" className="button button-ghost button-small" icon={<IconEditStroked />} onClick={() => setModal({ project })}>编辑</Button><Button size="small" className="button button-danger button-small" type="danger" icon={<IconDeleteStroked />} loading={deleting === project.id} onClick={() => confirmRemove(project)}>删除</Button></div></div>
            <Link to={paths.overview(project.id)} style={{ textDecoration: "none", color: "inherit", display: "block" }}><h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6, wordBreak: "break-all" }}>{project.name}</h2><p style={{ color: "var(--ink-600)", fontSize: 13, lineHeight: 1.5, marginBottom: 14 }}>{project.description || "暂无项目描述"}</p></Link>
          </div>
          <Link to={paths.overview(project.id)} style={{ textDecoration: "none", color: "inherit", display: "block" }}><div className="project-meta" style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}><div><span style={{ fontSize: 11, color: "var(--ink-500)", display: "block" }}>创建者: <strong style={{ color: "var(--ink-700)" }}>{project.owner_display_name || project.owner_name || "创建人"}</strong></span><span style={{ fontSize: 10, color: "var(--ink-400)" }}>{formatDate(project.updated_at)}</span></div><strong className="project-enter-link">进入项目 <IconChevronRight size="small" /></strong></div></Link>
        </div>
      </Card>)}
      <Button className="card project-card new-project-card semi-new-project" onClick={() => setModal({ project: null })}><span className="project-symbol"><IconPlus /></span><strong>新建项目</strong><span className="field-hint">创建独立图谱与日志空间</span></Button>
    </div>}
    {modal ? <ProjectModal project={modal.project} onClose={() => setModal(null)} onSaved={load} /> : null}
  </>;
}

function UsersTab() {
  const [state, setState] = useState({ loading: true, items: [], error: null });
  const [editing, setEditing] = useState(null);
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const { items } = await api.users();
      setState({ loading: false, items, error: null });
    } catch (error) {
      setState({ loading: false, items: [], error });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function updateRole(user, role) {
    setBusyId(user.id);
    try {
      await api.updateUser(user.id, { role, is_active: Number(user.is_active) });
      toast("用户角色权限已成功更新");
      await load();
    } catch (error) {
      toast(error.message, "error");
      await load();
    } finally {
      setBusyId("");
    }
  }

  async function toggleActive(user) {
    setBusyId(user.id);
    const next = user.is_active ? 0 : 1;
    try {
      await api.updateUser(user.id, { role: user.role, is_active: next });
      toast(`用户状态已切换为${next ? "启用" : "停用"}`);
      await load();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusyId("");
    }
  }

  const columns = [
    { title: "用户名 / 显示名 / 工号", render: (_, user) => <div style={{ display: "flex", alignItems: "center", gap: 10 }}><Avatar size="small">{(user.display_name || user.username).slice(0, 1).toUpperCase()}</Avatar><div><strong style={{ display: "block", fontSize: 13 }}>{user.username}</strong><span style={{ fontSize: 11, color: "var(--ink-500)" }}>{user.display_name || user.username}</span><span style={{ display: "block", fontSize: 11, color: "var(--ink-500)" }}>工号：{user.employee_id || "未设置"}</span></div></div> },
    { title: "账号角色", dataIndex: "role", render: (role) => <Tag className={`badge ${role === "admin" ? "badge-critical" : "badge-info"}`}>{role === "admin" ? "管理员" : "普通用户"}</Tag> },
    { title: "账号状态", dataIndex: "is_active", render: (active) => <Tag className={`badge ${active ? "badge-resolved" : "badge-ignored"}`}>{active ? "正常启用" : "已停用"}</Tag> },
    { title: "注册时间", dataIndex: "created_at", render: (value) => <span style={{ fontSize: 12, color: "var(--ink-500)" }}>{formatDate(value)}</span> },
    { title: "操作与权限设定", render: (_, user) => <div className="user-table-actions"><Button className="button button-secondary button-small" size="small" icon={<IconEditStroked />} onClick={() => setEditing(user)}>编辑</Button><Select className="compact-user-role-select" size="small" value={user.role} disabled={busyId === user.id} optionList={roleOptions} onChange={(role) => updateRole(user, role)} />{user.role === "admin" ? <Button className="user-state-button is-disabled-action" size="small" disabled>不可停用</Button> : <Button className={`user-state-button ${user.is_active ? "is-deactivate" : "is-activate"}`} size="small" theme="light" loading={busyId === user.id} onClick={() => toggleActive(user)}>{user.is_active ? "停用" : "启用"}</Button>}</div> },
  ];

  return <>
    <div className="page-header"><div><h1>用户与权限管理</h1><p>管理全站注册用户、修改姓名/重置密码、角色权限（管理员 / 普通用户）及账号启用/停用状态。</p></div></div>
    {state.loading ? <LoadingState message="正在拉取用户列表…" /> : state.error ? <ErrorState error={state.error} onRetry={load} /> : <section className="card"><div className="card-header"><div><h2>系统用户名录 ({state.items.length} 人)</h2><p>管理员可以修改用户姓名、重置密码、调整角色权限及账号状态。</p></div></div><div className="card-body flush"><Table className="logscope-semi-table" rowKey="id" columns={columns} dataSource={state.items} pagination={false} /></div></section>}
    {editing ? <AdminEditUserModal targetUser={editing} onClose={() => setEditing(null)} onUpdated={load} /> : null}
  </>;
}

export function ProjectsPage({ account, onLogout, onAccountUpdated }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = account?.role === "admin";
  const requested = searchParams.get("tab") || "projects";
  const current = isAdmin && ["projects", "users", "graph"].includes(requested) ? requested : "projects";
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    if (requested !== current) setSearchParams(current === "projects" ? {} : { tab: current }, { replace: true });
  }, [current, requested, setSearchParams]);

  return <AdminShell account={account} current={current} onLogout={onLogout} onProfile={() => setProfileOpen(true)}>
    {current === "users" ? <UsersTab /> : current === "graph" ? <GraphAdminPage /> : <ProjectsTab isAdmin={isAdmin} />}
    {profileOpen ? <ProfileModal account={account} onClose={() => setProfileOpen(false)} onUpdated={onAccountUpdated} /> : null}
  </AdminShell>;
}
