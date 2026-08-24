import React, { useState } from "react";
import { Button, Input, Select, TextArea } from "@douyinfe/semi-ui";
import { IconArchive, IconEditStroked, IconPause, IconPlus, IconTickCircle } from "@douyinfe/semi-icons";
import { api } from "../utils/api.js";
import { toast } from "../utils/ui.js";
import { Modal } from "./Ui.jsx";

const statusOptions = [
  { value: "active", label: <span className="select-option-with-icon"><IconTickCircle size="small" />正常运行 (active)</span> },
  { value: "paused", label: <span className="select-option-with-icon"><IconPause size="small" />暂停检测 (paused)</span> },
  { value: "archived", label: <span className="select-option-with-icon"><IconArchive size="small" />已归档 (archived)</span> },
];

export function ProjectModal({ project = null, onClose, onSaved }) {
  const isEdit = Boolean(project);
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState({ name: project?.name || "", description: project?.description || "", status: project?.status || "active" });

  async function submit(event) {
    event.preventDefault();
    const name = values.name.trim();
    const description = values.description.trim();
    if (!name) return toast("请输入项目名称", "error");
    setBusy(true);
    try {
      const result = isEdit
        ? await api.updateProject(project.id, { name, description, status: values.status })
        : await api.createProject({ name, description });
      toast(isEdit ? `项目“${name}”配置更新成功` : `项目“${name}”创建成功`);
      onClose?.();
      await onSaved?.(result.project || { ...project, name, description, status: values.status });
    } catch (err) {
      toast(err.message || "操作失败", "error");
      setBusy(false);
    }
  }

  return (
    <Modal title={<span style={{ display: "flex", alignItems: "center", gap: 8 }}>{isEdit ? <><IconEditStroked /> 编辑项目</> : <><IconPlus /> 新建项目</>}</span>} onClose={onClose} maxWidth={540}>
      <form onSubmit={submit}>
        <div className="field">
          <label>项目名称 <span style={{ color: "var(--danger)" }}>*</span></label>
          <Input className="input" value={values.name} placeholder="例如：电商微服务集群系统" onChange={(name) => setValues((v) => ({ ...v, name }))} />
          <span className="field-hint">建议使用具有标识度的系统或项目名称</span>
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <label>项目描述</label>
          <TextArea className="input" value={values.description} rows={3} placeholder="填写该项目的架构特点、核心模块或负责团队..." onChange={(description) => setValues((v) => ({ ...v, description }))} />
        </div>
        {isEdit ? <div className="field" style={{ marginTop: 14 }}>
          <label>项目运行状态</label>
          <Select className="select" value={values.status} optionList={statusOptions} onChange={(status) => setValues((v) => ({ ...v, status }))} />
          <span className="field-hint">状态更新将同步影响该项目的日志诊断与监控调度</span>
        </div> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
          <Button theme="light" type="tertiary" className="button button-secondary" onClick={onClose}>取消</Button>
          <Button htmlType="submit" theme="solid" type="primary" className="button button-primary" loading={busy}>{isEdit ? "保存修改" : "立即创建项目"}</Button>
        </div>
      </form>
    </Modal>
  );
}
