import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Modal, Table, Upload } from "@douyinfe/semi-ui";
import { IconDeleteStroked, IconPlay, IconUpload } from "@douyinfe/semi-icons";
import { Link } from "react-router-dom";
import { api } from "../utils/api.js";
import { taskManager } from "../tools/taskManager.js";
import { formatDate, toast } from "../utils/ui.js";
import { paths } from "../routes/paths.js";
import { ErrorState, EmptyState, LoadingState } from "../components/Ui.jsx";
import { TechTaskCard } from "../components/TechTaskCard.jsx";
import { useActiveTasks } from "../hooks/useActiveTasks.js";

const cache = new Map();
const steps = [{ at: 5, label: "结构化解析" }, { at: 20, label: "滑动窗口挖掘" }, { at: 65, label: "图谱 RCA 推理" }, { at: 90, label: "结论落盘" }];

function durationText(item) {
  const seconds = item.summary?.duration_seconds ?? item.duration_seconds;
  if (seconds == null) return "—";
  return Number(seconds) >= 60 ? `${Math.floor(Number(seconds) / 60)}分 ${Math.round(Number(seconds) % 60)}秒` : `${Number(seconds).toFixed(2)}s`;
}

export function LogsPage({ project }) {
  const [batches, setBatches] = useState(() => cache.get(project.id) || []);
  const [loading, setLoading] = useState(() => !cache.has(project.id));
  const [error, setError] = useState(null);
  const [file, setFile] = useState(null);
  const [fileList, setFileList] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const activeTasks = useActiveTasks();
  const activeTask = activeTasks.find((task) => task.type === "logs") || null;

  const load = useCallback(async () => {
    if (!cache.has(project.id)) setLoading(true);
    try {
      const items = (await api.logs(project.id)).items || [];
      cache.set(project.id, items);
      setBatches(items);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onDone = (event) => { if (event.detail?.type === "logs") load(); };
    taskManager.addEventListener("task:completed", onDone);
    return () => taskManager.removeEventListener("task:completed", onDone);
  }, [load]);

  const nameCounts = useMemo(() => batches.reduce((acc, item) => ({ ...acc, [item.filename]: (acc[item.filename] || 0) + 1 }), {}), [batches]);

  async function submit(event) {
    event.preventDefault();
    if (!file) return toast("请选择有效的日志文件 (.log / .txt / .zip)", "error");
    setSubmitting(true);
    try {
      const data = new FormData();
      data.append("file", file);
      await api.analyzeLogs(project.id, data);
      toast("日志分析与 RCA 根因推理任务已在后台启动！您可以自由切换页面。", "info");
      setFile(null);
      setFileList([]);
      await taskManager.pollNow();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function removeBatch(batch) {
    setDeletingId(batch.id);
    try {
      const result = await api.deleteBatch(project.id, batch.id);
      const next = batches.filter((item) => item.id !== batch.id);
      cache.set(project.id, next);
      setBatches(next);
      toast(result.warnings?.length ? `批次已删除；${result.warnings.join("；")}` : "日志批次及关联故障已删除");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setDeletingId("");
    }
  }

  function confirmDelete(batch) {
    const incidentCount = Number(batch.summary?.incidents || 0);
    Modal.confirm({
      title: "删除日志批次",
      content: `确定删除“${batch.filename}”吗？${incidentCount ? ` 该批次关联的 ${incidentCount} 个故障记录、RCA 动态图节点和分析产物也会永久删除。` : " 原始文件和分析产物也会永久删除。"}`,
      okText: "永久删除",
      cancelText: "取消",
      okType: "danger",
      onOk: () => removeBatch(batch),
    });
  }

  const columns = useMemo(() => [
    {
      title: "输入文件",
      dataIndex: "filename",
      render: (_, item) => <div><span className="table-title">{item.filename}</span>{nameCounts[item.filename] > 1 ? <span className="table-subtitle">{formatDate(item.created_at)}</span> : null}{item.train_filename ? <span className="table-subtitle">训练集：{item.train_filename}</span> : null}{item.error_message ? <span className="table-subtitle" style={{ color: "var(--danger)" }}>{item.error_message}</span> : null}</div>,
    },
    { title: "事件 / 窗口数", render: (_, item) => <><strong>{item.summary?.events ?? "—"}</strong> <small style={{ color: "var(--ink-500)" }}>/ {item.summary?.windows ?? "—"} 窗口</small></> },
    { title: "挖掘异常段数", render: (_, item) => item.summary?.incidents != null ? <Link to={paths.incidents(project.id, { batch: item.id })} style={{ fontWeight: 700, color: "var(--brand)", fontSize: 13 }}>{item.summary.incidents} 段</Link> : "—" },
    { title: "分析时长", render: (_, item) => <span className="table-subtitle" style={{ fontWeight: 600, color: "var(--ink-700)" }}>{durationText(item)}</span> },
    { title: "解析完成时间", render: (_, item) => formatDate(item.completed_at || item.created_at) },
    { title: "操作", render: (_, item) => <Button className="button button-danger button-small" theme="light" type="danger" icon={<IconDeleteStroked />} loading={deletingId === item.id} onClick={() => confirmDelete(item)}>删除</Button> },
  ], [deletingId, nameCounts, project.id]);

  if (loading && !batches.length) return <LoadingState message="正在读取日志批次…" />;
  if (error && !batches.length) return <ErrorState error={error} onRetry={load} />;

  return <>
    <div className="page-header"><div><h1>日志解析检测</h1><p>上传 Spring 风格服务日志，由滑动窗口算法生成异常区间、日志根因证据，再与系统架构拓扑联合推理。</p></div></div>
    <section className="card" style={{ marginBottom: 24 }}>
      <div className="card-header"><div><h2>新建分析批次</h2><p>支持上传单个 .log / .txt 或多服务日志包 ZIP；自动执行日志解析、窗口异常挖掘与图谱 RCA 推理。</p></div></div>
      <div className="card-body">
        <TechTaskCard task={activeTask} title="日志结构化解析与 RCA 诊断中" steps={steps} />
        <form className="form-stack" onSubmit={submit}>
          <Upload
            action="#"
            draggable
            accept=".log,.txt,.zip,text/plain,application/zip"
            limit={1}
            fileList={fileList}
            dragIcon={<IconUpload />}
            dragMainText={file?.name || "点击选择或拖拽日志文件 (ZIP / LOG / TXT)"}
            dragSubText="Spring Boot 多服务日志建议打包为 ZIP 文件上传"
            beforeUpload={({ file: item }) => {
              setFile(item.fileInstance);
              return { shouldUpload: false, autoRemove: false };
            }}
            onChange={({ fileList: next }) => setFileList([...next])}
            onRemove={() => { setFile(null); setFileList([]); }}
            className="logscope-upload"
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginTop: 16, flexWrap: "wrap" }}><div className="notice notice-info" style={{ margin: 0, flex: 1, minWidth: 280 }}>异步后台运行模式。已支持全流程真实进度条展示，长任务处理期间您可以随时无缝切换到其他页面。</div><Button className="button button-primary" htmlType="submit" theme="solid" type="primary" icon={<IconPlay />} loading={submitting} disabled={Boolean(activeTask)}>{activeTask ? "后台分析中..." : "开始异常检测与 RCA"}</Button></div>
        </form>
      </div>
    </section>
    <section className="card"><div className="card-header"><div><h2>日志批次历史</h2><p>原始输入、滑动窗口解析及挖掘段落按项目、批次隔离保存。</p></div></div><div className="card-body flush">{!batches.length ? <EmptyState title="还没有日志批次" detail="上传 Spring 日志后，分析记录会出现在这里。" /> : <Table className="logscope-semi-table" rowKey="id" columns={columns} dataSource={batches} pagination={false} />}</div></section>
  </>;
}
