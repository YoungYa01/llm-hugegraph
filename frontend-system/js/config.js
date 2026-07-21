export const API_BASE = (localStorage.getItem("logscope_api_base") || "http://127.0.0.1:8000/api").replace(/\/$/, "");

export const APP_NAME = "LogScope RCA";
export const APP_VERSION = "2026.07.21-r2";

export const STATUS_LABELS = {
  open: "待处理",
  in_progress: "处理中",
  resolved: "已解决",
  ignored: "已忽略",
  active: "运行中",
  paused: "已暂停",
  archived: "已归档",
  processing: "处理中",
  completed: "已完成",
  failed: "失败",
};

export const SEVERITY_LABELS = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重",
};
