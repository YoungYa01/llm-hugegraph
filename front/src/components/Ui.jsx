import React from "react";
import { Empty, Modal as SemiModal, Spin, Tag } from "@douyinfe/semi-ui";
import { IconAlertTriangle, IconInfoCircle, IconRefresh } from "@douyinfe/semi-icons";
import { SEVERITY_LABELS, STATUS_LABELS } from "../utils/config.js";
import { AppButton } from "./SemiAdapter.jsx";

export function Badge({ value, type = "status", className = "", children, style }) {
  const label = children ?? (type === "severity" ? SEVERITY_LABELS[value] : STATUS_LABELS[value]) ?? value ?? "—";
  return <Tag className={`badge badge-${value || "neutral"}${className ? ` ${className}` : ""}`} style={style}>{label}</Tag>;
}

export function LoadingState({ message = "正在加载…", minHeight }) {
  return <div className="state-panel semi-state-panel" style={minHeight ? { minHeight } : undefined}><Spin size="large" /><p>{message}</p></div>;
}

export function EmptyState({ title, detail, children, compact = false }) {
  return <div className={compact ? "empty-compact" : "empty-state"}><Empty image={<span className="semi-empty-state-icon"><IconInfoCircle /></span>} title={title} description={detail} />{children}</div>;
}

export function ErrorState({ error, onRetry }) {
  return <div className="empty-state error-state"><Empty image={<span className="semi-empty-state-icon semi-empty-state-icon-error"><IconAlertTriangle /></span>} title="加载失败" description={String(error?.message || error || "未知错误")} />{onRetry ? <AppButton icon={<IconRefresh />} className="button button-secondary" onClick={onRetry}>重新加载</AppButton> : null}</div>;
}

export function Modal({ title, children, onClose, maxWidth }) {
  return (
    <SemiModal
      visible
      title={title}
      footer={null}
      onCancel={onClose}
      closeOnEsc
      maskClosable
      width={maxWidth || 540}
      className="logscope-semi-modal"
    >
      {children}
    </SemiModal>
  );
}

export function BusyButton({ busy, busyText = "处理中…", children, disabled, className = "", type = "button", ...props }) {
  return <AppButton {...props} type={type} className={className} disabled={disabled || busy} loading={busy}>{busy ? busyText : children}</AppButton>;
}
