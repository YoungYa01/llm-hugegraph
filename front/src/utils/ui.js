import { Toast } from "@douyinfe/semi-ui";

Toast.config({ zIndex: 1200 });

export function escapeHtml(value = "") {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

export function formatDate(value) {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return escapeHtml(value);
	return new Intl.DateTimeFormat("zh-CN", {
		year: "2-digit",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).format(date);
}

export function formatConfidence(value) {
	const number = Number(value || 0);
	return `${Math.round(number * 100)}%`;
}

export function toast(message, kind = "success") {
	const method = kind === "error" ? "error" : kind === "warning" ? "warning" : kind === "info" ? "info" : "success";
	Toast[method]({
		content: String(message),
		duration: 3,
		showClose: false,
		stack: true,
	});
}
