import { api } from "../api.js";
import { graphLegend, renderGraph } from "../graph-view.js";
import { projectShell } from "../shell.js";
import { badge, errorState, escapeHtml, formatConfidence, formatDate, loading, setBusy, toast } from "../ui.js";

export async function renderIncidentDetailPage(root, project, incidentId) {
  root.innerHTML = projectShell(project, "incidents", `<div id="page-content">${loading("正在读取根因证据…")}</div>`);
  const content = root.querySelector("#page-content");
  let incident = null;
  let fusionGraph = { nodes: [], edges: [], warnings: [] };
  let fusionError = "";
  let includeEvents = false;
  let chainExpanded = false;
  let graphController = null;

  async function load() {
    try {
      incident = (await api.incident(project.id, incidentId)).incident;
      await loadFusionGraph();
      paint();
    } catch (error) {
      content.innerHTML = errorState(error, "retry-incident");
      content.querySelector("#retry-incident")?.addEventListener("click", load);
    }
  }

  async function loadFusionGraph() {
    fusionError = "";
    try {
      fusionGraph = (await api.incidentGraph(project.id, incidentId, includeEvents)).graph;
    } catch (error) {
      fusionGraph = { nodes: [], edges: [], warnings: [] };
      fusionError = error.message;
    }
  }

  function paint() {
    const analysis = incident.analysis || {};
    const detail = incident.detail || {};
    const llmDecision = analysis.llm_decision || {};
    const hypotheses = analysis.hypotheses || [];
    const top = hypotheses[0] || {
      candidate: incident.root_candidate,
      confidence: incident.root_confidence,
      fault_mode: incident.fault_mode,
      chain: incident.chain || [],
      reasons: [],
      evidence: [],
      missing_evidence: [],
    };
    const chain = top.chain || incident.chain || [];
    const llmCandidate = llmDecision.selected_candidate || top.candidate || "尚未形成判断";
    const llmReason = llmDecision.most_likely_reason || top.summary || analysis.decision || "暂无可展示的最可能原因";
    const llmSteps = llmDecision.troubleshooting_methods?.length
      ? llmDecision.troubleshooting_methods
      : (top.validation_suggestions || []).map((item) => item.title || item.reason || item.check_id).filter(Boolean);
    const llmConfidence = llmDecision.confidence || top.confidence;
    content.innerHTML = `
      <div class="page-header">
        <div><a class="link" href="#/projects/${project.id}/incidents">← 返回故障列表</a><h1 style="margin-top:12px">${escapeHtml(incident.title)}</h1><p>${escapeHtml(incident.external_incident_id)} · 发现于 ${formatDate(incident.created_at)}</p></div>
        <div class="page-actions">${badge(incident.severity, "severity")}${badge(incident.status)}</div>
      </div>

      <section class="cause-hero" style="margin-bottom:20px">
        <div class="llm-decision-grid">
          <div class="llm-decision-panel">
            <span class="stat-label">最可能原因</span>
            <h3>${escapeHtml(llmCandidate)}</h3>
            <p>${escapeHtml(llmReason)}</p>
            <div class="llm-decision-meta">
              <span class="badge">${escapeHtml(llmDecision.source || "fallback")}</span>
              <span class="badge">候选排行：${escapeHtml(llmDecision.selected_candidate_rank ? `Top-${llmDecision.selected_candidate_rank}` : `Top-${top.rank || 1}`)}</span>
              <span class="badge">${escapeHtml(llmDecision.selected_fault_mode || top.fault_mode || "UNKNOWN")}</span>
              ${llmConfidence ? `<span class="badge">置信度：${formatConfidence(llmConfidence)}</span>` : ""}
              <span class="badge">日志定位：${escapeHtml(analysis.resolved_root_service || detail.root_service_candidate || "未知服务")}</span>
            </div>
          </div>
          <div class="llm-decision-panel">
            <span class="stat-label">排查方法</span>
            ${llmSteps.length ? `<ol class="llm-step-list">${llmSteps.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>` : `<p>暂未生成排查方法。</p>`}
          </div>
        </div>
      </section>

      <section class="card fusion-graph-card" style="margin-bottom:20px">
        <div class="card-header"><div><h2>本次故障融合定位图</h2><p>仅在这里把当前 Incident、RCA 假设和证据节点与相关架构子图融合；不会污染架构管理页面。</p></div><button class="button ${includeEvents ? "button-primary" : "button-secondary"}" id="toggle-event-nodes">${includeEvents ? "隐藏日志事件" : "展开日志事件节点"}</button></div>
        <div class="card-body">
          ${fusionError ? `<div class="notice notice-warning" style="margin-bottom:12px">融合图暂不可用：${escapeHtml(fusionError)}。下方持久化 RCA 结论仍可正常查看。</div>` : ""}
          ${fusionGraph.warnings?.length ? `<div class="notice notice-warning" style="margin-bottom:12px">${escapeHtml(fusionGraph.warnings.join("；"))}</div>` : ""}
          ${fusionGraph.nodes.length ? `<div class="graph-shell graph-shell-fusion"><div id="fusion-graph-canvas"></div><div class="graph-toolbar"><button class="button button-ghost button-small" id="fusion-zoom-out">−</button><button class="button button-ghost button-small" id="fusion-zoom-reset">复位</button><button class="button button-ghost button-small" id="fusion-zoom-in">＋</button></div><div class="graph-legend">${graphLegend(true)}</div></div><div class="notice" id="fusion-selection" style="margin-top:10px">点击图中的节点或连线查看它在本次根因定位中的属性。</div>` : `<div class="empty-state"><div class="empty-icon">◇</div><h3>尚未读取到融合子图</h3><p>请确认 HugeGraph 中仍保留该日志批次的动态节点。</p></div>`}
        </div>
      </section>

      <div class="split-main">
        <div class="grid">
          <section class="card"><div class="card-header"><div><h2>推断出的故障传播链</h2><p>从底层候选向上游受影响服务展示；长链默认折叠中间节点。</p></div></div><div class="card-body">${chainHtml(chain, chainExpanded)}${stepsHtml(top.path_steps || [])}</div></section>
          <section class="card"><div class="card-header"><div><h2>为什么指向这个候选</h2><p>评分由日志故障特征、实体/端点命中与图距离共同构成。</p></div></div><div class="card-body">
            <h3>评分依据</h3>${listHtml(top.reasons, "暂时没有可展示的评分依据。")}
            <h3 style="margin-top:20px">直接证据</h3>${listHtml(top.evidence, detail.root_evidence || "没有独立的结构化证据。")}
            <h3 style="margin-top:20px">建议验证项</h3>${validationSuggestionsHtml(top.validation_suggestions || [])}
            ${top.missing_evidence?.length ? `<h3 style="margin-top:20px">仍需补充的证据</h3><div class="notice notice-warning">${top.missing_evidence.map((item) => `<p style="margin:0 0 7px">• ${escapeHtml(item)}</p>`).join("")}</div>` : ""}
          </div></section>
          <section class="card"><div class="card-header"><div><h2>日志错误时间线</h2><p>时间相邻只表示先后顺序；长时间线可按需展开。</p></div></div><div class="card-body">${timelineHtml(detail.timeline || [])}</div></section>
          ${hypotheses.length > 1 ? `<section class="card"><div class="card-header"><div><h2>其他根因候选</h2><p>不要只看 Top-1；证据不足时应核查多个候选。</p></div></div><div class="card-body flush">${hypothesesTable(hypotheses.slice(1))}</div></section>` : ""}
        </div>
        <aside class="grid">
          <section class="card"><div class="card-header"><div><h2>处理故障</h2><p>更新状态并形成可审计的解决记录。</p></div></div><div class="card-body"><form class="form-stack" id="status-form">
            <div class="field"><label>状态</label><select class="select" name="status"><option value="open" ${selected("open", incident.status)}>待处理</option><option value="in_progress" ${selected("in_progress", incident.status)}>处理中</option><option value="resolved" ${selected("resolved", incident.status)}>已解决</option><option value="ignored" ${selected("ignored", incident.status)}>已忽略</option></select></div>
            <div class="field"><label>处理/解决说明</label><textarea class="textarea" name="resolution_note" placeholder="例如：替换 redis-2 节点并完成主从重建；监控恢复。">${escapeHtml(incident.resolution_note || "")}</textarea><span class="field-hint">标记“已解决”时必须填写解决说明。</span></div>
            <button class="button button-primary" id="save-status" type="submit">保存处理结果</button>
          </form></div></section>
          <section class="card"><div class="card-header"><div><h2>日志侧原始定位</h2><p>这是异常栈和 trace 中的观测，不等同最终基础设施根因。</p></div></div><div class="card-body"><dl class="kv-list">
            <div class="kv-row"><dt>根因服务</dt><dd>${escapeHtml(detail.root_service_candidate || "—")}</dd></div>
            <div class="kv-row"><dt>底层异常</dt><dd>${escapeHtml(detail.root_cause_candidate || "—")}</dd></div>
            <div class="kv-row"><dt>单一 traceId</dt><dd><code>${escapeHtml(detail.primary_trace_id || "—")}</code></dd></div>
            <div class="kv-row"><dt>故障区间</dt><dd>${formatDate(detail.fault_start)}<br>至 ${formatDate(detail.fault_end)}</dd></div>
          </dl></div></section>
          <section class="card"><div class="card-header"><div><h2>处理历史</h2><p>记录检测和每次状态变更。</p></div></div><div class="card-body">${actionsHtml(incident.actions || [])}</div></section>
        </aside>
      </div>`;
    bind();
    renderFusionGraph();
  }
  function renderFusionGraph() {
    const canvas = content.querySelector("#fusion-graph-canvas");
    if (!canvas || !fusionGraph.nodes.length) return;
    graphController = renderGraph(canvas, fusionGraph, {
      onSelect: (node, edges) => {
        const panel = content.querySelector("#fusion-selection");
        panel.innerHTML = `<strong>${escapeHtml(node.name)}</strong> · ${escapeHtml(node.kind)}<br>${escapeHtml(node.description || "暂无描述")}<br><small>相邻关系：${edges.length}</small>`;
      },
      onSelectEdge: (edge) => {
        const panel = content.querySelector("#fusion-selection");
        panel.innerHTML = `<strong>${escapeHtml(edge.source)} —[${escapeHtml(edge.type)}]→ ${escapeHtml(edge.target)}</strong><br>${escapeHtml(edge.description || "暂无关系说明")}`;
      },
    });
  }

  function bind() {
    content.querySelector("#fusion-zoom-in")?.addEventListener("click", () => graphController?.zoomIn());
    content.querySelector("#fusion-zoom-out")?.addEventListener("click", () => graphController?.zoomOut());
    content.querySelector("#fusion-zoom-reset")?.addEventListener("click", () => graphController?.reset());
    content.querySelector("#toggle-event-nodes")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      setBusy(button, true, includeEvents ? "正在收起…" : "正在加载事件…");
      includeEvents = !includeEvents;
      await loadFusionGraph();
      paint();
    });
    content.querySelector("#toggle-chain")?.addEventListener("click", () => {
      chainExpanded = !chainExpanded;
      paint();
    });
    content.querySelector("#status-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(event.currentTarget));
      const button = content.querySelector("#save-status");
      setBusy(button, true, "保存中…");
      try {
        incident = (await api.updateIncidentStatus(project.id, incident.id, payload)).incident;
        toast("故障状态已更新");
        paint();
      } catch (error) { toast(error.message, "error"); setBusy(button, false); }
    });
  }

  await load();
}

function selected(value, current) { return value === current ? "selected" : ""; }

function chainHtml(chain, expanded) {
  if (!chain?.length) return `<p style="color:var(--ink-500)">没有形成可验证的图谱链路。</p>`;
  const shouldFold = chain.length > 6 && !expanded;
  const visible = shouldFold
    ? [chain[0], chain[1], `__fold__${chain.length - 4}`, chain.at(-2), chain.at(-1)]
    : chain;
  const nodes = visible.map((node, index) => {
    if (String(node).startsWith("__fold__")) {
      const count = String(node).replace("__fold__", "");
      return `${index ? '<span class="chain-arrow">→</span>' : ""}<button class="chain-node chain-fold" id="toggle-chain">中间 ${count} 个节点<br><small>点击展开</small></button>`;
    }
    return `${index ? '<span class="chain-arrow">→</span>' : ""}<span class="chain-node">${escapeHtml(node)}${index === 0 ? '<small style="display:block;color:var(--danger);margin-top:3px">根因候选</small>' : ""}</span>`;
  }).join("");
  const collapse = chain.length > 6 && expanded ? '<button class="button button-secondary button-small" id="toggle-chain" style="margin-top:8px">折叠中间节点</button>' : "";
  return `<div class="chain">${nodes}</div>${collapse}`;
}

function stepsHtml(steps) {
  if (!steps?.length) return "";
  const rows = steps.map((step) => `<div>${escapeHtml(step.source)} → ${escapeHtml(step.target)} <small>(${escapeHtml(step.basis || step.relation)})</small></div>`);
  if (rows.length <= 6) return `<div class="notice" style="margin-top:10px">${rows.join("")}</div>`;
  return `<details class="collapsible-details"><summary>展开 ${rows.length} 个路径依据</summary><div class="notice">${rows.join("")}</div></details>`;
}

function listHtml(items, fallback) {
  const values = items?.length ? items : [fallback];
  return `<ul class="evidence-list">${values.map((item) => `<li class="evidence-item">${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function validationSuggestionsHtml(items) {
  if (!items.length) return `<p style="color:var(--ink-500)">当前候选暂未生成验证建议。</p>`;
  return `<div class="timeline">${items.map((item) => `
    <div class="timeline-item">
      <time>${escapeHtml((item.priority || "medium").toUpperCase())} · ${escapeHtml(item.evidence_type || "evidence")} · ${escapeHtml(item.execution_mode || "manual")}</time>
      <p><strong>${escapeHtml(item.title || item.check_id || "验证项")}</strong></p>
      <p>${escapeHtml(item.reason || "")}</p>
      ${item.manual_command_hint ? `<small style="color:var(--ink-500)">${escapeHtml(item.manual_command_hint)}</small>` : ""}
    </div>`).join("")}</div>`;
}

function timelineHtml(items) {
  if (!items.length) return `<p style="color:var(--ink-500)">没有生成可用时间线。</p>`;
  const renderItems = (values) => `<div class="timeline">${values.map((item) => `<div class="timeline-item"><time>${formatDate(item.timestamp)} · ${escapeHtml(item.level || "LOG")} · ${escapeHtml(item.service || "未知服务")}</time><p>${escapeHtml(item.root_cause || item.message || "—")}</p>${item.trace_id ? `<small style="color:var(--ink-500)">trace: ${escapeHtml(item.trace_id)}</small>` : ""}</div>`).join("")}</div>`;
  const bounded = items.slice(0, 120);
  if (bounded.length <= 8) return renderItems(bounded);
  return `${renderItems(bounded.slice(0, 8))}<details class="collapsible-details"><summary>展开其余 ${bounded.length - 8} 条日志事件</summary>${renderItems(bounded.slice(8))}</details>`;
}

function hypothesesTable(items) {
  return `<div class="table-wrap"><table class="table"><thead><tr><th>排名</th><th>候选</th><th>故障模式</th><th>链路</th><th>评分</th></tr></thead><tbody>${items.map((item) => `<tr><td>Top-${item.rank}</td><td><strong>${escapeHtml(item.candidate)}</strong><span class="table-subtitle">${escapeHtml(item.candidate_kind)}</span></td><td>${escapeHtml(item.fault_mode)}</td><td>${escapeHtml((item.chain || []).join(" → "))}</td><td><strong>${formatConfidence(item.confidence)}</strong></td></tr>`).join("")}</tbody></table></div>`;
}

function actionsHtml(actions) {
  if (!actions.length) return `<p style="color:var(--ink-500)">暂无处理历史。</p>`;
  return `<div class="timeline">${actions.map((item) => `<div class="timeline-item"><time>${formatDate(item.created_at)} · ${escapeHtml(item.display_name || item.username)}</time><p><strong>${escapeHtml(item.action)}</strong>${item.note ? `：${escapeHtml(item.note)}` : ""}</p></div>`).join("")}</div>`;
}
