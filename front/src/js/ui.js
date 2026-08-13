import { SEVERITY_LABELS, STATUS_LABELS } from "./config.js";

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
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(date);
}

export function formatConfidence(value) {
  const number = Number(value || 0);
  return `${Math.round(number * 100)}%`;
}

export function badge(value, type = "status") {
  const label = type === "severity" ? SEVERITY_LABELS[value] : STATUS_LABELS[value];
  return `<span class="badge badge-${escapeHtml(value || "neutral")}">${escapeHtml(label || value || "—")}</span>`;
}

export function loading(message = "正在加载…") {
  return `<div class="state-panel"><span class="spinner"></span><p>${escapeHtml(message)}</p></div>`;
}

export function emptyState(title, detail, action = "") {
  return `<div class="empty-state"><div class="empty-icon">◇</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(detail)}</p>${action}</div>`;
}

export function errorState(error, retryId = "") {
  const button = retryId ? `<button class="button button-secondary" id="${retryId}">重新加载</button>` : "";
  return `<div class="empty-state error-state"><div class="empty-icon">!</div><h3>加载失败</h3><p>${escapeHtml(error?.message || error)}</p>${button}</div>`;
}

export function toast(message, kind = "success") {
  const root = document.querySelector("#toast-root");
  if (!root) return;
  const node = document.createElement("div");
  node.className = `toast toast-${kind}`;
  node.textContent = message;
  root.append(node);
  requestAnimationFrame(() => node.classList.add("show"));
  setTimeout(() => {
    node.classList.remove("show");
    setTimeout(() => node.remove(), 220);
  }, 3500);
}

export function setBusy(button, busy, label = "处理中…") {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

export function bindConfirm(selector, message, handler) {
  document.querySelector(selector)?.addEventListener("click", async (event) => {
    if (window.confirm(message)) await handler(event);
  });
}
