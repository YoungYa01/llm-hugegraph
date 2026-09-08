export const API_BASE = (localStorage.getItem("logscope_api_base") || `http://${location.hostname}:8000/api`).replace(
	/\/$/,
	"",
);

export const APP_NAME = "日志智能分析系统";
export const APP_LOGO = "/logo.png";
export const APP_VERSION = "";

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
	deleting: "删除中",
};

export const SEVERITY_LABELS = {
	low: "低",
	medium: "中",
	high: "高",
	critical: "严重",
};
