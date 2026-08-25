import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  IconAlertTriangle,
  IconArrowUp,
  IconBarChartVStroked,
  IconChevronDown,
  IconChevronLeft,
  IconFlag,
  IconLightningStroked,
  IconMinus,
  IconPlus,
  IconSearch,
  IconSetting,
  IconSync,
  IconWindowAdaptionStroked,
} from "@douyinfe/semi-icons";
import { BackTop, Button } from "@douyinfe/semi-ui";
import { api } from "../utils/api.js";
import { renderGraph } from "../tools/graph-view.js";
import { filterIncidentGraph } from "../tools/graph-semantics.js";
import { formatConfidence, formatDate, toast } from "../utils/ui.js";
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
} from "../components/Ui.jsx";
import {
  AppButton,
  AppSelect,
  AppTextArea,
} from "../components/SemiAdapter.jsx";
import { paths } from "../routes/paths.js";

function incidentListReturnPath(projectId, searchParams) {
  const fallback = paths.incidents(projectId, { page: 1, page_size: 20 });
  const requested = searchParams.get("return") || "";
  const expected = paths.incidents(projectId);
  return requested === expected || requested.startsWith(`${expected}?`)
    ? requested
    : fallback;
}
function selectedHypothesis(hypotheses, decision) {
  const modelPath = Array.isArray(decision?.propagation_path)
    ? decision.propagation_path
    : Array.isArray(decision?.display_chain)
      ? decision.display_chain
      : [];
  const modelChain = modelPath
    .filter(
      (item) =>
        item && typeof item === "object" && String(item.node || "").trim(),
    )
    .map((item) => String(item.node));
  if (
    String(decision?.source || "").toLowerCase() === "llm" &&
    decision?.selected_node_id &&
    modelChain.length
  )
    return {
      candidate: String(decision.selected_candidate || modelChain[0]),
      confidence: decision.confidence,
      fault_mode: decision.selected_fault_mode,
      chain: modelChain,
      rank: 0,
      source: "llm",
      path_steps: modelPath.map((item) => ({
        title: item.stage || "传播节点",
        reason: item.explanation || item.label || item.node,
      })),
    };
  if (!Array.isArray(hypotheses) || !hypotheses.length) return null;
  const candidate = String(decision?.selected_candidate || "")
    .trim()
    .toLowerCase();
  if (candidate) {
    const selected = hypotheses.find(
      (item) =>
        String(item?.candidate || "")
          .trim()
          .toLowerCase() === candidate,
    );
    if (selected) return selected;
  }
  const rank = Number(decision?.selected_candidate_rank || 0);
  return hypotheses.find((item) => Number(item?.rank || 0) === rank) || null;
}
function hypothesisForEvidence(hypotheses, decision) {
  if (!Array.isArray(hypotheses) || !hypotheses.length) return null;
  const selected = String(decision?.selected_candidate || "")
    .trim()
    .toLowerCase();
  if (selected) {
    const exact = hypotheses.find(
      (item) =>
        String(item?.candidate || "")
          .trim()
          .toLowerCase() === selected,
    );
    if (exact) return exact;
    const onChain = hypotheses.find(
      (item) =>
        Array.isArray(item?.chain) &&
        item.chain.some(
          (node) =>
            String(node || "")
              .trim()
              .toLowerCase() === selected,
        ),
    );
    if (onChain) return onChain;
  }
  const rank = Number(decision?.selected_candidate_rank || 0);
  return (
    hypotheses.find((item) => Number(item?.rank || 0) === rank) || hypotheses[0]
  );
}
function normalizedDisplayChain(value, algorithmChain) {
  if (!Array.isArray(value) || !value.length || !Array.isArray(algorithmChain))
    return [];
  const byNode = new Map(
    value
      .filter((item) => item && typeof item === "object")
      .map((item) => [String(item.node || ""), item]),
  );
  if (!algorithmChain.every((node) => byNode.has(String(node)))) return [];
  return algorithmChain.map((node, index) => {
    const item = byNode.get(String(node));
    return {
      node: String(node),
      label: String(item.label || node),
      explanation: String(item.explanation || ""),
      stage: String(
        item.stage ||
          (index === 0
            ? "根因"
            : index === algorithmChain.length - 1
              ? "受影响入口"
              : "故障传播"),
      ),
    };
  });
}
function normalizedReasonItems(value, fallback) {
  const values =
    Array.isArray(value) && value.length
      ? value
      : String(fallback || "").split(/(?:\r?\n|[；;])/);
  return [
    ...new Set(
      values
        .map((item) =>
          String(item || "")
            .replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "")
            .trim(),
        )
        .filter(Boolean),
    ),
  ].slice(0, 8);
}
function runtimeTargetSummary(runtime) {
  if (!runtime || typeof runtime !== "object") return "";
  const endpoints = Array.isArray(runtime.endpoints)
    ? runtime.endpoints.filter(Boolean)
    : [];
  if (endpoints.length) return endpoints.slice(0, 4).join("、");
  const hosts = [
    ...(Array.isArray(runtime.ips) ? runtime.ips : []),
    ...(Array.isArray(runtime.hostnames) ? runtime.hostnames : []),
  ].filter(Boolean);
  const ports = Array.isArray(runtime.ports)
    ? runtime.ports.filter(Boolean)
    : [];
  if (hosts.length && ports.length)
    return hosts
      .slice(0, 4)
      .map((host, index) => `${host}:${ports[index] || ports[0]}`)
      .join("、");
  if (hosts.length) return hosts.slice(0, 4).join("、");
  for (const key of [
    "instance_ids",
    "pods",
    "clusters",
    "namespaces",
    "health_checks",
  ]) {
    const values = Array.isArray(runtime[key])
      ? runtime[key].filter(Boolean)
      : [];
    if (values.length) return values.slice(0, 4).join("、");
  }
  return "";
}
function formatEvidenceItem(item) {
  if (typeof item !== "object") {
    const parts = String(item || "")
      .split(/\s+\|\s+/)
      .map((part) => part.trim())
      .filter(
        (part) => part && !/^\{["']?(?:event_id|timestamp)["']?\s*:/.test(part),
      );
    return [...new Set(parts)].join("\n").slice(0, 1600);
  }
  const exception = item.root_exception_class || item.exception_class || "";
  const message =
    item.root_cause ||
    item.semantic_message ||
    item.message ||
    item.representative_message ||
    "";
  const header = [
    item.timestamp,
    item.level ? `[${item.level}]` : "",
    item.service || item.service_name,
  ]
    .filter(Boolean)
    .join(" ");
  const parts = [header, exception, message].filter(Boolean);
  return (
    parts.length ? parts.join("\n") : JSON.stringify(item, null, 2)
  ).slice(0, 1600);
}
function evidenceTemplateKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(
      /\b\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g,
      "<time>",
    )
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>")
    .replace(/\/[a-z0-9_.{}:@%+-]+(?:\/[a-z0-9_.{}:@%+-]+)+/gi, "<path>")
    .replace(/\b(source_line|line|耗时|duration)\s*[:=]\s*\d+\b/gi, "$1=<n>")
    .replace(/^.*(?:直接目标标识|direct target).*$/gim, "")
    .replace(/^(?:<time>\s*)?(?:\[[^\]]+\]\s*)?[a-z0-9_.-]+\s*$/gim, "")
    .replace(/\s+/g, " ")
    .trim();
}
function collectDecisionEvidence(hypothesis, detail) {
  const ranked = [];
  const append = (value, priority) => {
    if (Array.isArray(value)) value.forEach((item) => append(item, priority));
    else if (value !== undefined && value !== null && value !== "")
      ranked.push({ value, priority });
  };
  append(detail?.root_evidence, 100);
  append(detail?.root_candidates || [], 95);
  append(hypothesis?.evidence || [], 90);
  append(detail?.upstream_effects || [], 75);
  (detail?.timeline || []).forEach((item, index) => {
    const level = String(item?.level || "").toUpperCase();
    const exception = item?.root_exception_class || item?.exception_class;
    const rootCause = item?.root_cause;
    const levelScore = ["FATAL", "CRITICAL"].includes(level)
      ? 30
      : level === "ERROR"
        ? 24
        : ["WARN", "WARNING"].includes(level)
          ? 8
          : 0;
    if (levelScore || exception || rootCause)
      ranked.push({
        value: item,
        priority:
          40 +
          levelScore +
          (exception ? 12 : 0) +
          (rootCause ? 10 : 0) -
          index / 100000,
      });
  });
  const selected = [];
  const seen = new Set();
  ranked.sort((a, b) => b.priority - a.priority);
  for (const item of ranked) {
    const text = formatEvidenceItem(item.value);
    const key = evidenceTemplateKey(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    selected.push(text);
    if (selected.length >= 1) break;
  }
  return selected;
}
function parseTimelineTime(value) {
  if (!value) return null;
  const time = new Date(
    String(value).trim().replace(" ", "T").replace(",", "."),
  ).getTime();
  return Number.isNaN(time) ? null : time;
}
function rawTimelineTime(value) {
  return String(value || "时间未知")
    .replace("T", " ")
    .replace(/Z$/, " UTC");
}
function relativeTimelineLabel(time, baseline, hasFaultStart) {
  if (time === null || baseline === null) return "相对时间未知";
  const delta = time - baseline;
  const prefix = hasFaultStart ? "故障" : "时间线";
  if (Math.abs(delta) < 1) return hasFaultStart ? "故障开始" : "时间线起点";
  const direction = delta < 0 ? "前" : "后";
  const absolute = Math.abs(delta);
  const minutes = Math.floor(absolute / 60000);
  const seconds = ((absolute % 60000) / 1000).toFixed(absolute % 1000 ? 3 : 0);
  const duration = minutes
    ? `${minutes}分${seconds === "0" ? "" : `${seconds}秒`}`
    : `${seconds}秒`;
  return `${prefix}${direction} ${duration}`;
}
function timelineRole(item, level) {
  const role = String(item?.incident_role || "").toLowerCase();
  if (["root", "root_candidate", "root-candidate"].includes(role))
    return "根因日志";
  if (item?.root_cause || item?.root_exception_class || item?.exception_class)
    return "关键异常";
  if (["FATAL", "CRITICAL", "ERROR"].includes(level)) return "错误事件";
  if (["WARN", "WARNING"].includes(level)) return "告警事件";
  return "上下文事件";
}

function ReasonList({ items, fallback }) {
  const values = items?.length ? items : [fallback];
  return (
    <ul className="evidence-list">
      {values.map((item, i) => (
        <li className="evidence-item" key={`${item}:${i}`}>
          {item}
        </li>
      ))}
    </ul>
  );
}
function OrderedReasons({ items }) {
  return items.length ? (
    <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 5 }}>
      {items.map((x, i) => (
        <li key={`${x}:${i}`}>{x}</li>
      ))}
    </ol>
  ) : (
    <p style={{ margin: 0, color: "var(--ink-500)" }}>
      暂无可展示的最可能原因。
    </p>
  );
}
function Timeline({ items, faultStart }) {
  if (!items.length)
    return <p style={{ color: "var(--ink-500)" }}>没有生成可用时间线。</p>;
  const ordered = items
    .map((item, index) => ({
      item,
      index,
      time: parseTimelineTime(item?.timestamp),
    }))
    .sort((a, b) =>
      a.time === null && b.time === null
        ? a.index - b.index
        : a.time === null
          ? 1
          : b.time === null
            ? -1
            : a.time - b.time || a.index - b.index,
    );
  const configuredStart = parseTimelineTime(faultStart);
  const baseline =
    configuredStart ?? ordered.find((e) => e.time !== null)?.time ?? null;
  const hasFaultStart = configuredStart !== null;
  const block = (values) => (
    <div className="timeline">
      {values.map(({ item, time }, index) => {
        const level = String(item.level || "LOG").toUpperCase();
        const role = timelineRole(item, level);
        const emphasis =
          role === "根因日志"
            ? " timeline-item-root"
            : ["关键异常", "错误事件"].includes(role)
              ? " timeline-item-error"
              : "";
        return (
          <div
            className={`timeline-item${emphasis}`}
            key={`${item.timestamp}:${index}`}
          >
            <time>
              <strong>
                {relativeTimelineLabel(time, baseline, hasFaultStart)}
              </strong>
              <span style={{ marginLeft: 7 }}>
                {rawTimelineTime(item.timestamp)}
              </span>
            </time>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                flexWrap: "wrap",
                marginBottom: 4,
              }}
            >
              <span className="badge" style={{ fontSize: 10 }}>
                {role}
              </span>
              <strong style={{ fontSize: 12, color: "var(--ink-800)" }}>
                {item.service || "未知服务"}
              </strong>
              <span style={{ fontSize: 11, color: "var(--ink-500)" }}>
                {level}
              </span>
            </div>
            <p>
              {item.root_cause || item.semantic_message || item.message || "—"}
            </p>
            {item.trace_id ? (
              <small style={{ color: "var(--ink-500)" }}>
                trace: {item.trace_id}
              </small>
            ) : null}
          </div>
        );
      })}
    </div>
  );
  return ordered.length <= 8 ? (
    block(ordered)
  ) : (
    <>
      {block(ordered.slice(0, 8))}
      <details className="collapsible-details">
        <summary>
          按时间顺序展开其余 {ordered.length - 8} 条事件（共 {ordered.length}{" "}
          条）
        </summary>
        {block(ordered.slice(8))}
      </details>
    </>
  );
}
function Chain({ chain, expanded, onToggle }) {
  if (!chain?.length)
    return (
      <p style={{ color: "var(--ink-500)" }}>没有形成可验证的图谱链路。</p>
    );
  const shouldFold = chain.length > 6 && !expanded;
  const visible = shouldFold
    ? [
        chain[0],
        chain[1],
        { __fold: chain.length - 4 },
        chain.at(-2),
        chain.at(-1),
      ]
    : chain;
  return (
    <>
      <div
        className="chain-vertical"
        style={{
          display: "flex",
          flexDirection: "column",
          paddingRight: 4,
          gap: 0,
        }}
      >
        {visible.map((entry, index) => {
          if (entry?.__fold)
            return (
              <React.Fragment key="fold">
                <div className="chain-arrow" aria-hidden="true">
                  <IconChevronDown size="small" />
                </div>
                <div style={{ textAlign: "center" }}>
                  <AppButton
                    className="button button-ghost button-small"
                    type="button"
                    style={{
                      fontSize: 11,
                      color: "var(--brand)",
                      padding: "2px 6px",
                    }}
                    onClick={onToggle}
                  >
                    展开中间 {entry.__fold} 个节点
                  </AppButton>
                </div>
                <div className="chain-arrow" aria-hidden="true">
                  <IconChevronDown size="small" />
                </div>
              </React.Fragment>
            );
          const item =
            typeof entry === "object" && entry !== null
              ? entry
              : {
                  node: String(entry),
                  label: String(entry),
                  explanation: "",
                  stage: "",
                };
          const isRoot = index === 0;
          const isLast = index === visible.length - 1;
          return (
            <React.Fragment key={`${item.node}:${index}`}>
              <div
                style={{
                  background: "#fff",
                  border: `1.5px solid ${isRoot ? "#dc2626" : "#cbd5e1"}`,
                  padding: "8px 12px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 8,
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                }}
              >
                <span
                  style={{
                    minWidth: 0,
                    color: isRoot ? "#dc2626" : "var(--ink-800)",
                    wordBreak: "break-word",
                    lineHeight: 1.35,
                  }}
                >
                  <strong style={{ display: "block" }}>
                    {item.label || item.node}
                  </strong>
                  {item.explanation ? (
                    <small
                      style={{
                        display: "block",
                        marginTop: 3,
                        color: "var(--ink-500)",
                        fontWeight: 400,
                      }}
                    >
                      {item.explanation}
                    </small>
                  ) : null}
                  {item.label && item.label !== item.node ? (
                    <small
                      style={{
                        display: "block",
                        marginTop: 2,
                        color: "var(--ink-400)",
                        fontWeight: 400,
                      }}
                    >
                      节点：{item.node}
                    </small>
                  ) : null}
                </span>
                {isRoot ? (
                  <span
                    className="badge"
                    style={{
                      background: "rgba(220,38,38,0.1)",
                      color: "#dc2626",
                      fontSize: 10,
                      padding: "1px 5px",
                      border: "1px solid rgba(220,38,38,0.2)",
                    }}
                  >
                    根因候选
                  </span>
                ) : null}
              </div>
              {!isLast ? (
                <div className="chain-arrow" aria-hidden="true">
                  <IconChevronDown size="small" />
                </div>
              ) : null}
            </React.Fragment>
          );
        })}
      </div>
      {chain.length > 6 && expanded ? (
        <AppButton
          className="button button-secondary button-small"
          type="button"
          style={{ marginTop: 6, fontSize: 11, width: "100%" }}
          onClick={onToggle}
        >
          折叠中间节点
        </AppButton>
      ) : null}
    </>
  );
}

export function IncidentDetailPage({ project, incidentId }) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [incident, setIncident] = useState(null);
  const [fusionGraph, setFusionGraph] = useState({
    nodes: [],
    edges: [],
    warnings: [],
  });
  const [fusionError, setFusionError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [chainExpanded, setChainExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState(null);
  const canvasRef = useRef(null);
  const controllerRef = useRef(null);
  async function load() {
    setLoading(true);
    try {
      const data = await api.incident(project.id, incidentId);
      setIncident(data.incident);
      setError(null);
      try {
        const graphRes = await api.incidentGraph(project.id, incidentId, false);
        setFusionGraph(graphRes.graph);
        setFusionError("");
      } catch (err) {
        setFusionGraph({ nodes: [], edges: [], warnings: [] });
        setFusionError(err.message);
      }
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, [project.id, incidentId]);
  const model = useMemo(() => {
    if (!incident) return null;
    const analysis = incident.analysis || {};
    const detail = incident.detail || {};
    const llmDecision = analysis.llm_decision || {};
    const hypotheses = analysis.hypotheses || [];
    const algorithmTop = hypotheses[0] || {
      candidate: incident.root_candidate,
      confidence: incident.root_confidence,
      fault_mode: incident.fault_mode,
      chain: incident.chain || [],
      reasons: [],
      evidence: [],
      missing_evidence: [],
    };
    const top = selectedHypothesis(hypotheses, llmDecision) || algorithmTop;
    const displayChain = normalizedDisplayChain(
      llmDecision.propagation_path || llmDecision.display_chain,
      top.chain || incident.chain || [],
    );
    const chain = displayChain.length
      ? displayChain
      : top.chain || incident.chain || [];
    const llmCandidate =
      incident.root_candidate ||
      llmDecision.selected_candidate ||
      top.candidate ||
      "尚未形成判断";
    const possibleMembers = Array.isArray(llmDecision.possible_member_nodes)
      ? llmDecision.possible_member_nodes
      : [];
    const llmReasons = normalizedReasonItems(
      llmDecision.most_likely_reasons,
      llmDecision.most_likely_reason ||
        top.summary ||
        analysis.decision ||
        "暂无可展示的最可能原因",
    );
    const llmSteps = llmDecision.troubleshooting_methods?.length
      ? llmDecision.troubleshooting_methods
      : (top.validation_suggestions || [])
          .map((item) => item.title || item.reason || item.check_id)
          .filter(Boolean);
    const supporting =
      hypothesisForEvidence(hypotheses, llmDecision) || algorithmTop;
    const evidenceNotes = [
      ...new Set(
        [
          ...(Array.isArray(llmDecision.notes)
            ? llmDecision.notes
            : llmDecision.notes
              ? [llmDecision.notes]
              : []),
          ...(supporting.missing_evidence || []),
        ]
          .map((x) => String(x || "").trim())
          .filter(Boolean),
      ),
    ];
    return {
      analysis,
      detail,
      llmDecision,
      hypotheses,
      top,
      chain,
      llmCandidate,
      possibleMembers,
      llmReasons,
      llmSteps,
      supporting,
      evidenceNotes,
      decisionEvidence: collectDecisionEvidence(supporting, detail),
      llmConfidence: llmDecision.confidence || top.confidence,
      rootRuntimeTarget: runtimeTargetSummary(
        llmDecision.selected_node_runtime,
      ),
      showMemberResolution:
        possibleMembers.length > 0 ||
        llmDecision.instance_resolution === "members_missing",
    };
  }, [incident]);
  const visibleGraph = useMemo(
    () => filterIncidentGraph(fusionGraph, false),
    [fusionGraph],
  );
  useEffect(() => {
    if (!incident || !model || !canvasRef.current || !visibleGraph.nodes.length)
      return undefined;
    const friendlyChain = normalizedDisplayChain(
      model.llmDecision.propagation_path || model.llmDecision.display_chain,
      model.top?.chain || [],
    );
    const friendlyByNode = new Map(
      friendlyChain.map((item) => [item.node, item]),
    );
    controllerRef.current?.destroy();
    controllerRef.current = renderGraph(canvasRef.current, visibleGraph, {
      mode: "incident",
      hypotheses: model.hypotheses,
      llmDecision: model.llmDecision,
      onSelect: (node, edges) =>
        setSelection({
          type: "node",
          node,
          edges,
          friendly: friendlyByNode.get(node.name),
        }),
      onSelectEdge: (edge) => setSelection({ type: "edge", edge }),
    });
    return () => {
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [incident, model, visibleGraph]);
  async function saveStatus(event) {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget));
      const res = await api.updateIncidentStatus(
        project.id,
        incident.id,
        payload,
      );
      setIncident(res.incident);
      toast("故障状态已更新");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSaving(false);
    }
  }
  if (loading) return <LoadingState message="正在读取根因证据…" />;
  if (error || !incident || !model)
    return <ErrorState error={error || "故障不存在"} onRetry={load} />;
  const returnPath = incidentListReturnPath(project.id, searchParams);
  const {
    detail,
    llmDecision,
    top,
    chain,
    llmCandidate,
    possibleMembers,
    llmReasons,
    llmSteps,
    evidenceNotes,
    decisionEvidence,
    llmConfidence,
    rootRuntimeTarget,
    showMemberResolution,
  } = model;
  return (
    <>
      <div className="page-header">
        <div>
          <Link
            className="link"
            to={returnPath}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              marginBottom: 8,
              fontSize: 13,
            }}
          >
            <IconChevronLeft size="small" />
            返回故障列表
          </Link>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <h1
              style={{
                margin: 0,
                fontSize: 20,
                fontWeight: 700,
                lineHeight: 1.4,
              }}
            >
              {incident.title}
            </h1>
          </div>
          <p style={{ marginTop: 6, color: "var(--ink-500)", fontSize: 13 }}>
            故障单号：
            <code
              style={{
                background: "var(--surface-soft)",
                padding: "2px 6px",
                borderRadius: 4,
                fontFamily: "monospace",
              }}
            >
              {incident.external_incident_id}
            </code>
            &nbsp;·&nbsp; 发现时间：{formatDate(incident.created_at)}
          </p>
        </div>
        <div
          className="page-actions"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          {incident.log_batch_id ? (
            <Link
              className="button button-secondary button-small link-button-with-icon"
              to={paths.reports(project.id)}
            >
              <IconBarChartVStroked size="small" />
              进入综合报告中心
            </Link>
          ) : null}
          <Badge value={incident.severity} type="severity" />
          <Badge value={incident.status} />
        </div>
      </div>
      <section
        className="cause-hero"
        style={{
          marginBottom: 20,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 20,
          boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
        }}
      >
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}
          className="hero-grid-responsive"
        >
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 12,
              }}
            >
              <span
                className="stat-label stat-label-with-icon"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  color: "var(--ink-500)",
                  textTransform: "uppercase",
                }}
              >
                <IconFlag size="small" />
                最可能根因节点
              </span>
              {llmConfidence ? (
                <span
                  className="badge badge-subtle"
                  style={{ fontWeight: 600, color: "var(--brand)" }}
                >
                  置信度: {formatConfidence(llmConfidence)}
                </span>
              ) : null}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 12,
              }}
            >
              <h2
                style={{
                  margin: 0,
                  fontSize: 22,
                  color: "var(--danger)",
                  fontWeight: 700,
                }}
              >
                {llmCandidate}
              </h2>
              <span
                className="badge"
                style={{
                  background: "rgba(220,38,38,0.1)",
                  color: "#dc2626",
                  border: "1px solid rgba(220,38,38,0.2)",
                }}
              >
                {top.fault_mode ||
                  llmDecision.selected_fault_mode ||
                  "故障未知"}
              </span>
            </div>
            {rootRuntimeTarget ? (
              <div
                style={{
                  margin: "-4px 0 12px",
                  color: "var(--ink-600)",
                  fontSize: 13,
                }}
              >
                <strong>运行目标：</strong>
                <code
                  style={{
                    background: "var(--surface-soft)",
                    padding: "2px 6px",
                    borderRadius: 4,
                  }}
                >
                  {rootRuntimeTarget}
                </code>
              </div>
            ) : null}
            <div
              style={{
                color: "var(--ink-700)",
                fontSize: 14,
                lineHeight: 1.6,
                marginBottom: 14,
                background: "var(--surface-soft)",
                padding: "12px 14px",
                borderRadius: 8,
                borderLeft: "4px solid var(--brand)",
              }}
            >
              <strong
                style={{
                  display: "block",
                  marginBottom: 6,
                  color: "var(--ink-800)",
                }}
              >
                根因判断依据
              </strong>
              <OrderedReasons items={llmReasons} />
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                fontSize: 12,
              }}
            >
              <span className="badge">
                来源: {llmDecision.source || "RCA 推理引擎"}
              </span>
              <span className="badge">
                {top.source === "llm"
                  ? "架构约束模型结论"
                  : `候选排名: ${top.rank ? `Top-${top.rank}` : llmDecision.selected_candidate_rank ? `Top-${llmDecision.selected_candidate_rank}` : "Top-1"}`}
              </span>
              <span className="badge">
                日志侧定位:{" "}
                {model.analysis.resolved_root_service ||
                  detail.root_service_candidate ||
                  "未知服务"}
              </span>
            </div>
          </div>
          <div
            style={{ borderLeft: "1px solid var(--border)", paddingLeft: 24 }}
            className="hero-steps-border"
          >
            <span
              className="stat-label stat-label-with-icon"
              style={{
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 0.5,
                color: "var(--ink-500)",
                textTransform: "uppercase",
                display: "flex",
                marginBottom: 12,
              }}
            >
              <IconSetting size="small" />
              建议排查与处置步骤
            </span>
            {llmSteps.length ? (
              <ol
                style={{
                  margin: 0,
                  paddingLeft: 20,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {llmSteps.map((step, i) => (
                  <li
                    key={`${step}:${i}`}
                    style={{
                      fontSize: 13,
                      lineHeight: 1.5,
                      color: "var(--ink-800)",
                    }}
                  >
                    {step}
                  </li>
                ))}
              </ol>
            ) : (
              <p style={{ color: "var(--ink-500)", fontSize: 13 }}>
                暂无自动推荐的处置步骤，请核查下方证据与日志链。
              </p>
            )}
          </div>
        </div>
      </section>
      {showMemberResolution ? (
        <section
          className="card"
          style={{ marginBottom: 20, borderColor: "rgba(217,119,6,0.3)" }}
        >
          <div
            className="card-header"
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 16,
            }}
          >
            <div>
              <h2>集群待排查实例</h2>
              <p>
                当前日志只能确认集群级异常，无法判定具体故障实例。以下节点全部来自系统架构图谱，仅作为待排查可能性，不代表已确认根因。
              </p>
            </div>
            <span
              className="badge"
              style={{
                whiteSpace: "nowrap",
                background: "rgba(217,119,6,0.1)",
                color: "#b45309",
                border: "1px solid rgba(217,119,6,0.2)",
              }}
            >
              {possibleMembers.length
                ? `${possibleMembers.length} 个真实成员`
                : "成员关系缺失"}
            </span>
          </div>
          <div className="card-body">
            <div className="notice notice-warning" style={{ marginBottom: 14 }}>
              正式根因仍为“{llmCandidate}
              ”。请结合实例健康状态、集群角色、网络连通性及节点日志逐一缩小范围。
            </div>
            {possibleMembers.length ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))",
                  gap: 12,
                  maxHeight: 440,
                  overflow: "auto",
                  paddingRight: 4,
                }}
              >
                {possibleMembers.map((member, i) => {
                  const runtimeTarget = String(
                    member?.target ||
                      runtimeTargetSummary(member?.runtime) ||
                      "",
                  ).trim();
                  const direct = Boolean(member?.direct_evidence);
                  return (
                    <article
                      key={`${member?.name}:${i}`}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: 10,
                        padding: 14,
                        background: "var(--surface)",
                        minWidth: 0,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          justifyContent: "space-between",
                          gap: 8,
                          marginBottom: 10,
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <strong
                            style={{
                              display: "block",
                              color: "var(--ink-900)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {member?.name || "未知实例"}
                          </strong>
                          <span
                            style={{ fontSize: 12, color: "var(--ink-500)" }}
                          >
                            {member?.kind || "Instance"}
                          </span>
                        </div>
                        <span
                          className="badge"
                          style={{
                            background: direct
                              ? "rgba(220,38,38,0.1)"
                              : "rgba(217,119,6,0.1)",
                            color: direct ? "#b91c1c" : "#b45309",
                            border: `1px solid ${direct ? "rgba(220,38,38,0.2)" : "rgba(217,119,6,0.2)"}`,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {direct ? "日志标识命中 · 优先核查" : "待排查"}
                        </span>
                      </div>
                      <div style={{ fontSize: 13, marginBottom: 8 }}>
                        <span style={{ color: "var(--ink-500)" }}>
                          运行目标：
                        </span>
                        {runtimeTarget ? (
                          <code
                            style={{
                              background: "var(--surface-soft)",
                              padding: "2px 6px",
                              borderRadius: 4,
                              wordBreak: "break-all",
                            }}
                          >
                            {runtimeTarget}
                          </code>
                        ) : (
                          <span style={{ color: "var(--danger)" }}>
                            图谱未维护 IP/端口
                          </span>
                        )}
                      </div>
                      <p
                        style={{
                          margin: 0,
                          color: "var(--ink-600)",
                          fontSize: 12,
                          lineHeight: 1.6,
                        }}
                      >
                        {member?.reason ||
                          "属于异常集群，当前缺少实例级直接证据。"}
                      </p>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="notice notice-warning">
                {llmDecision.member_resolution_warning ||
                  "架构图谱没有维护该聚合节点与实例之间的成员关系，暂时无法列出具体排查节点。"}
              </div>
            )}
          </div>
        </section>
      ) : null}
      <section className="card fusion-graph-card" style={{ marginBottom: 20 }}>
        <div
          className="card-header"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <h2>本次故障融合定位拓扑与传播链</h2>
            <p>
              仅展示真实系统组件及最终选定的故障传播路径；内部推理和审计实体不会出现在图中。
            </p>
          </div>
        </div>
        <div className="card-body">
          {fusionError ? (
            <div className="notice notice-warning" style={{ marginBottom: 12 }}>
              融合图暂不可用：{fusionError}。下方持久化 RCA 结论仍可正常查看。
            </div>
          ) : null}
          {fusionGraph.warnings?.length ? (
            <div className="notice notice-warning" style={{ marginBottom: 12 }}>
              {fusionGraph.warnings.join("；")}
            </div>
          ) : null}
          {visibleGraph.nodes.length ? (
            <div className="incident-graph-layout">
              <div className="graph-shell graph-shell-fusion">
                <div ref={canvasRef} />
                <div className="graph-toolbar">
                  <AppButton
                    icon={<IconMinus />}
                    className="button button-ghost button-small graph-icon-button"
                    type="button"
                    onClick={() => controllerRef.current?.zoomOut()}
                    title="缩小"
                    aria-label="缩小图谱"
                  />
                  <AppButton
                    icon={<IconWindowAdaptionStroked />}
                    className="button button-ghost button-small"
                    type="button"
                    onClick={() => controllerRef.current?.reset()}
                    title="复位画布"
                  >
                    适配画布
                  </AppButton>
                  <AppButton
                    icon={<IconPlus />}
                    className="button button-ghost button-small graph-icon-button"
                    type="button"
                    onClick={() => controllerRef.current?.zoomIn()}
                    title="放大"
                    aria-label="放大图谱"
                  />
                  <AppButton
                    icon={<IconSync />}
                    className="button button-ghost button-small"
                    type="button"
                    onClick={() => controllerRef.current?.relayout()}
                    title="清除节点固定位置并重新布局"
                  >
                    重新布局
                  </AppButton>
                </div>
                <div className="graph-legend">
                  <span>
                    <i
                      className="legend-dot"
                      style={{ background: "#c44578" }}
                    />
                    界面交互
                  </span>
                  <span>
                    <i
                      className="legend-dot"
                      style={{ background: "#3f6fba" }}
                    />
                    服务
                  </span>
                  <span>
                    <i
                      className="legend-dot"
                      style={{ background: "#178a80" }}
                    />
                    数据资源
                  </span>
                  <span>
                    <i
                      className="legend-dot"
                      style={{ background: "#117b74" }}
                    />
                    集群
                  </span>
                  <span>
                    <i
                      className="legend-dot"
                      style={{ background: "#c8722f" }}
                    />
                    实例
                  </span>
                  <span>
                    <i
                      className={`legend-line ${top.source === "llm" ? "legend-line-model" : "legend-line-algorithm"}`}
                    />
                    选定传播链
                  </span>
                </div>
              </div>
              <div className="incident-graph-aside">
                <section className="incident-graph-panel incident-chain-panel">
                  <h3>故障传播链 (Propagation Chain)</h3>
                  <div className="incident-chain-scroll">
                    <Chain
                      chain={chain}
                      expanded={chainExpanded}
                      onToggle={() => setChainExpanded((x) => !x)}
                    />
                  </div>
                </section>
                <section className="incident-graph-panel incident-selection-panel">
                  <h3>节点/连线属性解析</h3>
                  <div className="incident-selection-content">
                    {!selection ? (
                      "点击左侧图谱中的节点或连线，在此处实时查看具体定位属性与依赖。"
                    ) : selection.type === "node" ? (
                      <div
                        style={{
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          padding: "8px 10px",
                          fontSize: 12,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            marginBottom: 4,
                            gap: 6,
                          }}
                        >
                          <code
                            style={{
                              fontWeight: 700,
                              color: "var(--brand)",
                              fontSize: 12,
                              wordBreak: "break-all",
                            }}
                          >
                            {selection.friendly?.label || selection.node.name}
                          </code>
                          <span
                            className="badge"
                            style={{
                              fontSize: 10,
                              background: "var(--surface-soft)",
                              color: "var(--ink-700)",
                              flexShrink: 0,
                            }}
                          >
                            {selection.friendly?.stage ||
                              selection.node.kind ||
                              "Node"}
                          </span>
                        </div>
                        {selection.friendly?.label &&
                        selection.friendly.label !== selection.node.name ? (
                          <div
                            style={{ color: "var(--ink-500)", fontSize: 11 }}
                          >
                            真实节点：{selection.node.name}
                          </div>
                        ) : null}
                        {selection.friendly?.explanation ? (
                          <div
                            style={{
                              margin: "5px 0",
                              color: "var(--ink-800)",
                              lineHeight: 1.4,
                            }}
                          >
                            {selection.friendly.explanation}
                          </div>
                        ) : null}
                        {selection.node.description ? (
                          <div
                            style={{
                              margin: "4px 0",
                              color: "var(--ink-700)",
                              lineHeight: 1.4,
                              wordBreak: "break-all",
                            }}
                          >
                            {selection.node.description}
                          </div>
                        ) : null}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            marginTop: 6,
                            paddingTop: 4,
                            borderTop: "1px dashed var(--border)",
                            color: "var(--ink-500)",
                            fontSize: 11,
                          }}
                        >
                          <span>相邻关联实体:</span>
                          <strong style={{ color: "var(--ink-800)" }}>
                            {selection.edges.length} 个关系
                          </strong>
                        </div>
                      </div>
                    ) : (
                      <div
                        style={{
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          padding: "8px 10px",
                          fontSize: 12,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            marginBottom: 4,
                            fontWeight: 700,
                            color: "var(--ink-800)",
                            flexWrap: "wrap",
                          }}
                        >
                          <code>{selection.edge.source}</code>
                          <span
                            className="badge"
                            style={{
                              background: "rgba(37,99,235,0.1)",
                              color: "var(--brand)",
                              fontSize: 10,
                            }}
                          >
                            -[ {selection.edge.type} ]→
                          </span>
                          <code>{selection.edge.target}</code>
                        </div>
                        <div
                          style={{
                            marginTop: 4,
                            color: selection.edge.description
                              ? "var(--ink-700)"
                              : "var(--ink-500)",
                            lineHeight: 1.4,
                            fontStyle: selection.edge.description
                              ? undefined
                              : "italic",
                          }}
                        >
                          {selection.edge.description || "暂无直接关系描述"}
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              </div>
            </div>
          ) : (
            <EmptyState
              title="尚未形成可展示的架构传播链"
              detail="请确认根因和传播路径中的组件均存在于系统架构图谱。"
            />
          )}
        </div>
      </section>
      <div
        className="incident-detail-floating-actions"
        aria-label="故障详情快捷操作"
      >
        <Button
          className="incident-detail-return-floating"
          icon={<IconChevronLeft />}
          onClick={() => navigate(returnPath)}
        >
          返回故障列表
        </Button>
      </div>
      <BackTop
        className="incident-detail-backtop"
        visibilityHeight={360}
        duration={320}
        aria-label="回到页面顶部"
      >
        <IconArrowUp />
      </BackTop>
      <div className="split-main">
        <div className="grid" style={{ gap: 20 }}>
          <section className="card">
            <div className="card-header">
              <div>
                <h2>根因判定依据与日志证据</h2>
                <p>综合算法评分、日志异常堆栈及拓扑图距离判定。</p>
              </div>
            </div>
            <div className="card-body">
              <div className="evidence-code-blocks">
                {decisionEvidence.map((item, i) => (
                  <div style={{ marginBottom: 10 }} key={i}>
                    <pre
                      style={{
                        background: "#1e293b",
                        color: "#f8fafc",
                        padding: "12px 14px",
                        borderRadius: 8,
                        fontFamily: "Consolas,Monaco,monospace",
                        fontSize: 12,
                        lineHeight: 1.5,
                        overflowX: "auto",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                      }}
                    >
                      <code>{item}</code>
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          </section>
          <section className="card">
            <div className="card-header">
              <div>
                <h2>日志异常时间线 (Timeline)</h2>
                <p>按事件发生时间升序排列，直观还原故障演进过程。</p>
              </div>
            </div>
            <div className="card-body">
              <Timeline
                items={detail.timeline || []}
                faultStart={detail.fault_start}
              />
            </div>
          </section>
        </div>
        <aside className="grid" style={{ gap: 20 }}>
          <section className="card">
            <div className="card-header">
              <div>
                <h2 className="section-title-with-icon">
                  <IconLightningStroked size="small" />
                  故障处理跟进
                </h2>
                <p>更新故障处理状态并存档闭环记录。</p>
              </div>
            </div>
            <div className="card-body">
              <form className="form-stack" onSubmit={saveStatus}>
                <div className="field">
                  <label>更新状态</label>
                  <AppSelect
                    className="select"
                    name="status"
                    style={{ fontWeight: 600 }}
                    defaultValue={incident.status}
                    key={incident.status}
                  >
                    <option value="open">待处理 (Open)</option>
                    <option value="in_progress">处理中 (In Progress)</option>
                    <option value="resolved">已解决 (Resolved)</option>
                    <option value="ignored">已忽略 (Ignored)</option>
                  </AppSelect>
                </div>
                <div className="field">
                  <label>处理/恢复记录说明</label>
                  <AppTextArea
                    className="textarea"
                    name="resolution_note"
                    rows="3"
                    placeholder="例如：已完成死锁隔离与配置优化，服务恢复正常运行。"
                    defaultValue={incident.resolution_note || ""}
                    key={`${incident.status}:note`}
                  />
                  <span className="field-hint">
                    标记为“已解决”时，建议记录具体的故障原因与修复处理措施。
                  </span>
                </div>
                <AppButton
                  className="button button-primary"
                  type="submit"
                  style={{ width: "100%" }}
                  disabled={saving}
                >
                  {saving ? "保存中…" : "保存处理结果"}
                </AppButton>
              </form>
            </div>
          </section>
          <section className="card">
            <div className="card-header">
              <div>
                <h2>日志侧原始观测数据</h2>
                <p>来自日志窗口算法与 TraceId 的观测上下文。</p>
              </div>
            </div>
            <div className="card-body">
              <dl className="kv-list">
                <div className="kv-row">
                  <dt>根因候选服务</dt>
                  <dd>
                    <strong>{detail.root_service_candidate || "—"}</strong>
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>异常模式/类型</dt>
                  <dd>
                    <code style={{ fontSize: 12 }}>
                      {detail.root_cause_candidate || "—"}
                    </code>
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>关联 TraceId</dt>
                  <dd>
                    <code>{detail.primary_trace_id || "—"}</code>
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>异常故障窗口</dt>
                  <dd style={{ fontSize: 12 }}>
                    {formatDate(detail.fault_start)}
                    <br />至 {formatDate(detail.fault_end)}
                  </dd>
                </div>
              </dl>
            </div>
          </section>
          <section className="card">
            <div className="card-header">
              <div>
                <h2>处理操作历史</h2>
                <p>记录本故障从创建到历次状态变更。</p>
              </div>
            </div>
            <div className="card-body">
              {incident.actions?.length ? (
                <div className="timeline">
                  {incident.actions.map((item, i) => (
                    <div className="timeline-item" key={i}>
                      <time>
                        {formatDate(item.created_at)} ·{" "}
                        {item.display_name || item.username}
                      </time>
                      <p>
                        <strong>{item.action}</strong>
                        {item.note ? `：${item.note}` : ""}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ color: "var(--ink-500)" }}>暂无处理历史。</p>
              )}
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
