import { api } from "../api.js";
import { graphLegend, renderGraph } from "../graph-view.js";
import { filterIncidentGraph } from "../graph-semantics.js";
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
    graphController?.destroy();
    graphController = null;
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
    const chain = displayChain.length ? displayChain : (top.chain || incident.chain || []);
    // Scalar incident columns are the current, operator-editable canonical
    // values. analysis/detail JSON remains the source for narrative evidence.
    const llmCandidate = incident.root_candidate || llmDecision.selected_candidate || top.candidate || "尚未形成判断";
    const llmReasons = normalizedReasonItems(
      llmDecision.most_likely_reasons,
      llmDecision.most_likely_reason || top.summary || analysis.decision || "暂无可展示的最可能原因",
    );
    const llmSteps = llmDecision.troubleshooting_methods?.length
      ? llmDecision.troubleshooting_methods
      : (top.validation_suggestions || []).map((item) => item.title || item.reason || item.check_id).filter(Boolean);
    const llmConfidence = llmDecision.confidence || top.confidence;
    const supportingHypothesis = hypothesisForEvidence(hypotheses, llmDecision) || algorithmTop;
    const decisionEvidence = collectDecisionEvidence(supportingHypothesis, detail);
    const visibleFusionGraph = filterIncidentGraph(fusionGraph, false);
    const evidenceNotes = uniqueTextItems([
      ...(Array.isArray(llmDecision.notes) ? llmDecision.notes : (llmDecision.notes ? [llmDecision.notes] : [])),
      ...(supportingHypothesis.missing_evidence || []),
    ]);

    content.innerHTML = `
      <div class="page-header">
        <div>
          <a class="link" href="#/projects/${project.id}/incidents" style="display:inline-flex;align-items:center;gap:4px;margin-bottom:8px;font-size:13px">
            ← 返回故障列表
          </a>
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <h1 style="margin:0;font-size:20px;font-weight:700;line-height:1.4">${escapeHtml(incident.title)}</h1>
          </div>
          <p style="margin-top:6px;color:var(--ink-500);font-size:13px">
            故障单号：<code style="background:var(--surface-soft);padding:2px 6px;border-radius:4px;font-family:monospace">${escapeHtml(incident.external_incident_id)}</code>
            &nbsp;·&nbsp; 发现时间：${formatDate(incident.created_at)}
          </p>
        </div>
        <div class="page-actions" style="display:flex;align-items:center;gap:8px">
          ${incident.log_batch_id ? `<a class="button button-secondary button-small" href="#/projects/${project.id}/reports">进入综合报告中心</a>` : ""}
          ${badge(incident.severity, "severity")}
          ${badge(incident.status)}
        </div>
      </div>

      <!-- 核心诊断 Hero 面板 -->
      <section class="cause-hero" style="margin-bottom:20px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.04)">
        <div style="display:grid;grid-template-columns: 1fr 1fr;gap:24px" class="hero-grid-responsive">
          <!-- 左侧：根因定位结论 -->
          <div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <span class="stat-label" style="font-size:12px;font-weight:700;letter-spacing:0.5px;color:var(--ink-500);text-transform:uppercase">🎯 最可能根因节点</span>
              ${llmConfidence ? `<span class="badge badge-subtle" style="font-weight:600;color:var(--brand)">置信度: ${formatConfidence(llmConfidence)}</span>` : ""}
            </div>
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
              <h2 style="margin:0;font-size:22px;color:var(--danger);font-weight:700">${escapeHtml(llmCandidate)}</h2>
              <span class="badge" style="background:rgba(220,38,38,0.1);color:#dc2626;border:1px solid rgba(220,38,38,0.2)">${escapeHtml(top.fault_mode || llmDecision.selected_fault_mode || "故障未知")}</span>
            </div>
            <div style="color:var(--ink-700);font-size:14px;line-height:1.6;margin-bottom:14px;background:var(--surface-soft);padding:12px 14px;border-radius:8px;border-left:4px solid var(--brand)">
              <strong style="display:block;margin-bottom:6px;color:var(--ink-800)">根因判断依据</strong>
              ${reasonItemsHtml(llmReasons)}
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;font-size:12px">
              <span class="badge">来源: ${escapeHtml(llmDecision.source || "RCA 推理引擎")}</span>
              <span class="badge">${top.source === "llm" ? "架构约束模型结论" : `候选排名: ${escapeHtml(top.rank ? `Top-${top.rank}` : (llmDecision.selected_candidate_rank ? `Top-${llmDecision.selected_candidate_rank}` : "Top-1"))}`}</span>
              <span class="badge">日志侧定位: ${escapeHtml(analysis.resolved_root_service || detail.root_service_candidate || "未知服务")}</span>
            </div>
          </div>

          <!-- 右侧：推荐处置与排查步骤 -->
          <div style="border-left:1px solid var(--border);padding-left:24px" class="hero-steps-border">
            <span class="stat-label" style="font-size:12px;font-weight:700;letter-spacing:0.5px;color:var(--ink-500);text-transform:uppercase;display:block;margin-bottom:12px">🛠️ 建议排查与处置步骤</span>
            ${llmSteps.length ? `
              <ol style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:10px">
                ${llmSteps.map((step) => `<li style="font-size:13px;line-height:1.5;color:var(--ink-800)">${escapeHtml(step)}</li>`).join("")}
              </ol>
            ` : `<p style="color:var(--ink-500);font-size:13px">暂无自动推荐的处置步骤，请核查下方证据与日志链。</p>`}
          </div>
        </div>
      </section>

      <!-- 本次故障融合定位拓扑与传播链 -->
      <section class="card fusion-graph-card" style="margin-bottom:20px">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <h2>本次故障融合定位拓扑与传播链</h2>
            <p>仅展示真实系统组件及最终选定的故障传播路径；内部推理和审计实体不会出现在图中。</p>
          </div>
        </div>
        <div class="card-body">
          ${fusionError ? `<div class="notice notice-warning" style="margin-bottom:12px">融合图暂不可用：${escapeHtml(fusionError)}。下方持久化 RCA 结论仍可正常查看。</div>` : ""}
          ${fusionGraph.warnings?.length ? `<div class="notice notice-warning" style="margin-bottom:12px">${escapeHtml(fusionGraph.warnings.join("；"))}</div>` : ""}
          ${visibleFusionGraph.nodes.length ? `
            <div class="incident-graph-layout">
              <!-- 左侧：可缩放、可拖拽的故障定位拓扑 -->
              <div class="graph-shell graph-shell-fusion">
                <div id="fusion-graph-canvas"></div>
                <div class="graph-toolbar">
                  <button class="button button-ghost button-small" id="fusion-zoom-out" title="缩小">−</button>
                  <button class="button button-ghost button-small" id="fusion-zoom-reset" title="复位画布">复位</button>
                  <button class="button button-ghost button-small" id="fusion-zoom-in" title="放大">＋</button>
                  <button class="button button-ghost button-small" id="fusion-relayout" title="清除节点固定位置并重新布局">重排</button>
                </div>
                <div class="graph-legend">${graphLegend(false)}<span><i class="legend-line ${top.source === "llm" ? "legend-line-model" : "legend-line-algorithm"}"></i>选定传播链</span></div>
              </div>
              <!-- 右侧：传播链和选中元素说明 -->
              <div class="incident-graph-aside">
                <section class="incident-graph-panel incident-chain-panel">
                  <h3>
                    故障传播链 (Propagation Chain)
                  </h3>
                  <div class="incident-chain-scroll">
                    ${chainHtml(chain, chainExpanded)}
                  </div>
                </section>

                <section class="incident-graph-panel incident-selection-panel">
                  <h3>节点/连线属性解析</h3>
                  <div id="fusion-selection" class="incident-selection-content">
                    点击左侧图谱中的节点或连线，在此处实时查看具体定位属性与依赖。
                  </div>
                </section>
              </div>
            </div>
          ` : `
            <div class="empty-state"><div class="empty-icon">◇</div><h3>尚未形成可展示的架构传播链</h3><p>请确认根因和传播路径中的组件均存在于系统架构图谱。</p></div>
          `}
        </div>
      </section>

      <!-- 主体双栏布局 -->
      <div class="split-main">
        <!-- 左栏：排查深度分析 -->
        <div class="grid" style="gap:20px">
          <!-- 1. 根因诊断依据与证据 -->
          <section class="card">
            <div class="card-header">
              <div>
                <h2>根因判定依据与日志证据</h2>
                <p>综合算法评分、日志异常堆栈及拓扑图距离判定。</p>
              </div>
            </div>
            <div class="card-body">
              <h3 style="font-size:14px;font-weight:700;margin-bottom:8px;color:var(--ink-700)">📊 根因判定依据</h3>
              ${listHtml(llmReasons, "暂时没有可展示的根因判定依据。")}

              <h3 style="font-size:14px;font-weight:700;margin-top:20px;margin-bottom:8px;color:var(--ink-700)">🔍 关键日志堆栈证据</h3>
              ${renderFormattedEvidence(decisionEvidence)}

              <h3 style="font-size:14px;font-weight:700;margin-top:20px;margin-bottom:8px;color:var(--ink-700)">🛠️ 推荐验证项</h3>
              ${listHtml(llmSteps, "当前结论暂未生成验证建议。")}

              ${evidenceNotes.length ? `
                <h3 style="font-size:14px;font-weight:700;margin-top:20px;margin-bottom:8px;color:var(--danger)">⚠️ 建议补充的证据与注意事项</h3>
                <div class="notice notice-warning">${evidenceNotes.map((item) => `<p style="margin:0 0 6px">• ${escapeHtml(item)}</p>`).join("")}</div>
              ` : ""}
            </div>
          </section>

          <!-- 2. 日志错误时间线 -->
          <section class="card">
            <div class="card-header">
              <div>
                <h2>日志异常时间线 (Timeline)</h2>
                <p>按事件发生时间升序排列，直观还原故障演进过程。</p>
              </div>
            </div>
            <div class="card-body">
              ${timelineHtml(detail.timeline || [], detail.fault_start)}
            </div>
          </section>

        </div>

        <!-- 右栏：运维操作与元数据 -->
        <aside class="grid" style="gap:20px">
          <!-- 1. 故障处理与处置 (置顶在右侧第一位) -->
          <section class="card">
            <div class="card-header">
              <div>
                <h2>⚡ 故障处理跟进</h2>
                <p>更新故障处理状态并存档闭环记录。</p>
              </div>
            </div>
            <div class="card-body">
              <form class="form-stack" id="status-form">
                <div class="field">
                  <label>更新状态</label>
                  <select class="select" name="status" style="font-weight:600">
                    <option value="open" ${selected("open", incident.status)}>🔴 待处理 (Open)</option>
                    <option value="in_progress" ${selected("in_progress", incident.status)}>🟡 处理中 (In Progress)</option>
                    <option value="resolved" ${selected("resolved", incident.status)}>🟢 已解决 (Resolved)</option>
                    <option value="ignored" ${selected("ignored", incident.status)}>⚪ 已忽略 (Ignored)</option>
                  </select>
                </div>
                <div class="field">
                  <label>处理/恢复记录说明</label>
                  <textarea class="textarea" name="resolution_note" rows="3" placeholder="例如：已完成死锁隔离与配置优化，服务恢复正常运行。">${escapeHtml(incident.resolution_note || "")}</textarea>
                  <span class="field-hint">标记为“已解决”时，建议记录具体的故障原因与修复处理措施。</span>
                </div>
                <button class="button button-primary" id="save-status" type="submit" style="width:100%">
                  保存处理结果
                </button>
              </form>
            </div>
          </section>

          <!-- 2. 日志侧原始检测元数据 -->
          <section class="card">
            <div class="card-header">
              <div>
                <h2>日志侧原始观测数据</h2>
                <p>来自日志窗口算法与 TraceId 的观测上下文。</p>
              </div>
            </div>
            <div class="card-body">
              <dl class="kv-list">
                <div class="kv-row"><dt>根因候选服务</dt><dd><strong>${escapeHtml(detail.root_service_candidate || "—")}</strong></dd></div>
                <div class="kv-row"><dt>异常模式/类型</dt><dd><code style="font-size:12px">${escapeHtml(detail.root_cause_candidate || "—")}</code></dd></div>
                <div class="kv-row"><dt>关联 TraceId</dt><dd><code>${escapeHtml(detail.primary_trace_id || "—")}</code></dd></div>
                <div class="kv-row"><dt>异常故障窗口</dt><dd style="font-size:12px">${formatDate(detail.fault_start)}<br>至 ${formatDate(detail.fault_end)}</dd></div>
              </dl>
            </div>
          </section>

          <!-- 3. 审计与处理历史 -->
          <section class="card">
            <div class="card-header">
              <div>
                <h2>处理操作历史</h2>
                <p>记录本故障从创建到历次状态变更。</p>
              </div>
            </div>
            <div class="card-body">
              ${actionsHtml(incident.actions || [])}
            </div>
          </section>
        </aside>
      </div>`;
    bind();
    renderFusionGraph();
  }
  function renderFusionGraph() {
    const canvas = content.querySelector("#fusion-graph-canvas");
    const visibleGraph = filterIncidentGraph(fusionGraph, false);
    if (!canvas || !visibleGraph.nodes.length) return;
    const decision = incident.analysis?.llm_decision || {};
    const hypothesis = selectedHypothesis(incident.analysis?.hypotheses || [], decision);
    const friendlyChain = normalizedDisplayChain(
      decision.propagation_path || decision.display_chain,
      hypothesis?.chain || [],
    );
    const friendlyByNode = new Map(friendlyChain.map((item) => [item.node, item]));
    graphController = renderGraph(canvas, visibleGraph, {
      mode: "incident",
      hypotheses: incident.analysis?.hypotheses || [],
      llmDecision: incident.analysis?.llm_decision || {},
      onSelect: (node, edges) => {
        const panel = content.querySelector("#fusion-selection");
        const friendly = friendlyByNode.get(node.name);
        panel.innerHTML = `
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:12px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;gap:6px">
              <code style="font-weight:700;color:var(--brand);font-size:12px;word-break:break-all">${escapeHtml(friendly?.label || node.name)}</code>
              <span class="badge" style="font-size:10px;background:var(--surface-soft);color:var(--ink-700);flex-shrink:0">${escapeHtml(friendly?.stage || node.kind || "Node")}</span>
            </div>
            ${friendly?.label && friendly.label !== node.name ? `<div style="color:var(--ink-500);font-size:11px">真实节点：${escapeHtml(node.name)}</div>` : ""}
            ${friendly?.explanation ? `<div style="margin:5px 0;color:var(--ink-800);line-height:1.4">${escapeHtml(friendly.explanation)}</div>` : ""}
            ${node.description ? `<div style="margin:4px 0;color:var(--ink-700);line-height:1.4;word-break:break-all">${escapeHtml(node.description)}</div>` : ""}
            <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px;padding-top:4px;border-top:1px dashed var(--border);color:var(--ink-500);font-size:11px">
              <span>相邻关联实体:</span>
              <strong style="color:var(--ink-800)">${edges.length} 个关系</strong>
            </div>
          </div>`;
      },
      onSelectEdge: (edge) => {
        const panel = content.querySelector("#fusion-selection");
        panel.innerHTML = `
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:12px">
            <div style="display:flex;align-items:center;gap:4px;margin-bottom:4px;font-weight:700;color:var(--ink-800);flex-wrap:wrap">
              <code>${escapeHtml(edge.source)}</code>
              <span class="badge" style="background:rgba(37,99,235,0.1);color:var(--brand);font-size:10px">-[ ${escapeHtml(edge.type)} ]→</span>
              <code>${escapeHtml(edge.target)}</code>
            </div>
            ${edge.description ? `<div style="margin-top:4px;color:var(--ink-700);line-height:1.4">${escapeHtml(edge.description)}</div>` : `<div style="margin-top:4px;color:var(--ink-500);font-style:italic">暂无直接关系描述</div>`}
          </div>`;
      },
    });
  }

  function bind() {
    content.querySelector("#fusion-zoom-in")?.addEventListener("click", () => graphController?.zoomIn());
    content.querySelector("#fusion-zoom-out")?.addEventListener("click", () => graphController?.zoomOut());
    content.querySelector("#fusion-zoom-reset")?.addEventListener("click", () => graphController?.reset());
    content.querySelector("#fusion-relayout")?.addEventListener("click", () => graphController?.relayout());
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

  const nodes = visible.map((entry, index) => {
    if (String(entry).startsWith("__fold__")) {
      const count = String(entry).replace("__fold__", "");
      return `
        <div style="text-align:center;padding:2px 0;color:var(--ink-400);font-weight:bold;font-size:14px">↓</div>
        <div style="text-align:center">
          <button class="button button-ghost button-small" id="toggle-chain" style="font-size:11px;color:var(--brand);padding:2px 6px">展开中间 ${count} 个节点</button>
        </div>
        <div style="text-align:center;padding:2px 0;color:var(--ink-400);font-weight:bold;font-size:14px">↓</div>`;
    }
    const item = typeof entry === "object" && entry !== null
      ? entry
      : { node: String(entry), label: String(entry), explanation: "", stage: "" };
    const isRoot = index === 0;
    const isLast = index === visible.length - 1;
    const arrow = !isLast ? `<div style="text-align:center;padding:3px 0;color:var(--ink-400);font-weight:bold;font-size:14px">↓</div>` : "";

    return `
      <div style="background:#fff;border:1.5px solid ${isRoot ? '#dc2626' : '#cbd5e1'};padding:8px 12px;border-radius:6px;font-size:12px;font-weight:600;display:flex;align-items:flex-start;justify-content:space-between;gap:8px;box-shadow:0 1px 3px rgba(0,0,0,0.04)">
        <span style="min-width:0;color:${isRoot ? '#dc2626' : 'var(--ink-800)'};word-break:break-word;line-height:1.35">
          <strong style="display:block">${escapeHtml(item.label || item.node)}</strong>
          ${item.explanation ? `<small style="display:block;margin-top:3px;color:var(--ink-500);font-weight:400">${escapeHtml(item.explanation)}</small>` : ""}
          ${item.label && item.label !== item.node ? `<small style="display:block;margin-top:2px;color:var(--ink-400);font-weight:400">节点：${escapeHtml(item.node)}</small>` : ""}
        </span>
        ${isRoot ? `<span class="badge" style="background:rgba(220,38,38,0.1);color:#dc2626;font-size:10px;padding:1px 5px;border:1px solid rgba(220,38,38,0.2)">根因候选</span>` : ""}
      </div>
      ${arrow}`;
  }).join("");

  const collapse = chain.length > 6 && expanded ? '<button class="button button-secondary button-small" id="toggle-chain" style="margin-top:6px;font-size:11px;width:100%">折叠中间节点</button>' : "";

  return `<div class="chain-vertical" style="display:flex;flex-direction:column;padding-right:4px;gap:0">${nodes}</div>${collapse}`;
}

function selectedHypothesis(hypotheses, decision) {
  const modelPath = Array.isArray(decision?.propagation_path)
    ? decision.propagation_path
    : Array.isArray(decision?.display_chain) ? decision.display_chain : [];
  const modelChain = modelPath
    .filter((item) => item && typeof item === "object" && String(item.node || "").trim())
    .map((item) => String(item.node));
  if (String(decision?.source || "").toLocaleLowerCase() === "llm" && decision?.selected_node_id && modelChain.length) {
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
  }
  if (!Array.isArray(hypotheses) || !hypotheses.length) return null;
  const candidate = String(decision?.selected_candidate || "").trim().toLocaleLowerCase();
  if (candidate) {
    const selected = hypotheses.find((item) => String(item?.candidate || "").trim().toLocaleLowerCase() === candidate);
    if (selected) return selected;
  }
  const rank = Number(decision?.selected_candidate_rank || 0);
  return hypotheses.find((item) => Number(item?.rank || 0) === rank) || null;
}

function hypothesisForEvidence(hypotheses, decision) {
  if (!Array.isArray(hypotheses) || !hypotheses.length) return null;
  const selected = String(decision?.selected_candidate || "").trim().toLocaleLowerCase();
  if (selected) {
    const exact = hypotheses.find((item) => String(item?.candidate || "").trim().toLocaleLowerCase() === selected);
    if (exact) return exact;
    const onChain = hypotheses.find((item) => (
      Array.isArray(item?.chain)
      && item.chain.some((node) => String(node || "").trim().toLocaleLowerCase() === selected)
    ));
    if (onChain) return onChain;
  }
  const rank = Number(decision?.selected_candidate_rank || 0);
  return hypotheses.find((item) => Number(item?.rank || 0) === rank) || hypotheses[0];
}

function normalizedDisplayChain(value, algorithmChain) {
  if (!Array.isArray(value) || !value.length || !Array.isArray(algorithmChain)) return [];
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
      stage: String(item.stage || (index === 0 ? "根因" : index === algorithmChain.length - 1 ? "受影响入口" : "故障传播")),
    };
  });
}

function normalizedReasonItems(value, fallback) {
  const values = Array.isArray(value) && value.length
    ? value
    : String(fallback || "").split(/(?:\r?\n|[；;])/);
  return [...new Set(values
    .map((item) => String(item || "").replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "").trim())
    .filter(Boolean))].slice(0, 8);
}

function reasonItemsHtml(items) {
  if (!items.length) return `<p style="margin:0;color:var(--ink-500)">暂无可展示的最可能原因。</p>`;
  return `<ol style="margin:0;padding-left:20px;display:grid;gap:5px">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>`;
}

function listHtml(items, fallback) {
  const values = items?.length ? items : [fallback];
  return `<ul class="evidence-list">${values.map((item) => `<li class="evidence-item">${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function collectDecisionEvidence(hypothesis, detail) {
  const ranked = [];
  const append = (value, priority) => {
    if (Array.isArray(value)) value.forEach((item) => append(item, priority));
    else if (value !== undefined && value !== null && value !== "") ranked.push({ value, priority });
  };
  append(detail?.root_evidence, 100);
  append(detail?.root_candidates || [], 95);
  append(hypothesis?.evidence || [], 90);
  append(detail?.upstream_effects || [], 75);
  (detail?.timeline || []).forEach((item, index) => {
    const level = String(item?.level || "").toUpperCase();
    const exception = item?.root_exception_class || item?.exception_class;
    const rootCause = item?.root_cause;
    const levelScore = ["FATAL", "CRITICAL"].includes(level) ? 30 : level === "ERROR" ? 24 : ["WARN", "WARNING"].includes(level) ? 8 : 0;
    if (levelScore || exception || rootCause) ranked.push({
      value: item,
      priority: 40 + levelScore + (exception ? 12 : 0) + (rootCause ? 10 : 0) - (index / 100000),
    });
  });

  const selected = [];
  const seenTemplates = new Set();
  ranked.sort((left, right) => right.priority - left.priority);
  for (const item of ranked) {
    const text = formatEvidenceItem(item.value);
    const key = evidenceTemplateKey(text);
    if (!text || !key || seenTemplates.has(key)) continue;
    seenTemplates.add(key);
    selected.push(text);
    if (selected.length >= 1) break;
  }
  return selected;
}

function formatEvidenceItem(item) {
  if (typeof item !== "object") {
    const parts = String(item || "")
      .split(/\s+\|\s+/)
      .map((part) => part.trim())
      .filter((part) => part && !/^\{["']?(?:event_id|timestamp)["']?\s*:/.test(part));
    return [...new Set(parts)].join("\n").slice(0, 1600);
  }
  const exception = item.root_exception_class || item.exception_class || "";
  const message = item.root_cause || item.semantic_message || item.message || item.representative_message || "";
  const header = [
    item.timestamp,
    item.level ? `[${item.level}]` : "",
    item.service || item.service_name,
  ].filter(Boolean).join(" ");
  const parts = [header, exception, message].filter(Boolean);
  return (parts.length ? parts.join("\n") : JSON.stringify(item, null, 2)).slice(0, 1600);
}

function evidenceTemplateKey(value) {
  return String(value || "")
    .toLocaleLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<time>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>")
    .replace(/\/[a-z0-9_.{}:@%+-]+(?:\/[a-z0-9_.{}:@%+-]+)+/gi, "<path>")
    .replace(/\b(source_line|line|耗时|duration)\s*[:=]\s*\d+\b/gi, "$1=<n>")
    .replace(/^.*(?:直接目标标识|direct target).*$/gim, "")
    .replace(/^(?:<time>\s*)?(?:\[[^\]]+\]\s*)?[a-z0-9_.-]+\s*$/gim, "")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueTextItems(values) {
  return [...new Set((values || []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function renderFormattedEvidence(items) {
  if (!items.length) return `<p style="color:var(--ink-500)">没有独立的结构化日志证据。</p>`;
  return `<div style="margin-bottom:8px;color:var(--ink-500);font-size:12px">仅展示与当前根因结论关联度最高的一条原始日志；完整事件请查看下方时间线。</div><div class="evidence-code-blocks">${items.map((item) => `
    <div style="margin-bottom:10px">
      <pre style="background:#1e293b;color:#f8fafc;padding:12px 14px;border-radius:8px;font-family:Consolas,Monaco,monospace;font-size:12px;line-height:1.5;overflow-x:auto;white-space:pre-wrap;word-break:break-all"><code>${escapeHtml(String(item))}</code></pre>
    </div>
  `).join("")}</div>`;
}

function timelineHtml(items, faultStart) {
  if (!items.length) return `<p style="color:var(--ink-500)">没有生成可用时间线。</p>`;
  const ordered = items
    .map((item, index) => ({ item, index, time: parseTimelineTime(item?.timestamp) }))
    .sort((left, right) => {
      if (left.time === null && right.time === null) return left.index - right.index;
      if (left.time === null) return 1;
      if (right.time === null) return -1;
      return left.time - right.time || left.index - right.index;
    });
  const configuredStart = parseTimelineTime(faultStart);
  const firstValidTime = ordered.find((entry) => entry.time !== null)?.time ?? null;
  const baseline = configuredStart ?? firstValidTime;
  const hasFaultStart = configuredStart !== null;
  const renderItems = (values) => `<div class="timeline">${values.map(({ item, time }) => {
    const level = String(item.level || "LOG").toUpperCase();
    const role = timelineRole(item, level);
    const relative = relativeTimelineLabel(time, baseline, hasFaultStart);
    const emphasis = role === "根因日志" ? " timeline-item-root" : role === "关键异常" || role === "错误事件" ? " timeline-item-error" : "";
    return `<div class="timeline-item${emphasis}">
      <time><strong>${escapeHtml(relative)}</strong><span style="margin-left:7px">${escapeHtml(rawTimelineTime(item.timestamp))}</span></time>
      <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:4px">
        <span class="badge" style="font-size:10px">${escapeHtml(role)}</span>
        <strong style="font-size:12px;color:var(--ink-800)">${escapeHtml(item.service || "未知服务")}</strong>
        <span style="font-size:11px;color:var(--ink-500)">${escapeHtml(level)}</span>
      </div>
      <p>${escapeHtml(item.root_cause || item.semantic_message || item.message || "—")}</p>
      ${item.trace_id ? `<small style="color:var(--ink-500)">trace: ${escapeHtml(item.trace_id)}</small>` : ""}
    </div>`;
  }).join("")}</div>`;
  if (ordered.length <= 8) return renderItems(ordered);
  return `${renderItems(ordered.slice(0, 8))}<details class="collapsible-details"><summary>按时间顺序展开其余 ${ordered.length - 8} 条事件（共 ${ordered.length} 条）</summary>${renderItems(ordered.slice(8))}</details>`;
}

function parseTimelineTime(value) {
  if (!value) return null;
  const normalized = String(value).trim().replace(" ", "T").replace(",", ".");
  const time = new Date(normalized).getTime();
  return Number.isNaN(time) ? null : time;
}

function rawTimelineTime(value) {
  return String(value || "时间未知").replace("T", " ").replace(/Z$/, " UTC");
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
  const duration = minutes ? `${minutes}分${seconds === "0" ? "" : `${seconds}秒`}` : `${seconds}秒`;
  return `${prefix}${direction} ${duration}`;
}

function timelineRole(item, level) {
  const role = String(item?.incident_role || "").toLocaleLowerCase();
  if (["root", "root_candidate", "root-candidate"].includes(role)) return "根因日志";
  if (item?.root_cause || item?.root_exception_class || item?.exception_class) return "关键异常";
  if (["FATAL", "CRITICAL", "ERROR"].includes(level)) return "错误事件";
  if (["WARN", "WARNING"].includes(level)) return "告警事件";
  return "上下文事件";
}

function actionsHtml(actions) {
  if (!actions.length) return `<p style="color:var(--ink-500)">暂无处理历史。</p>`;
  return `<div class="timeline">${actions.map((item) => `<div class="timeline-item"><time>${formatDate(item.created_at)} · ${escapeHtml(item.display_name || item.username)}</time><p><strong>${escapeHtml(item.action)}</strong>${item.note ? `：${escapeHtml(item.note)}` : ""}</p></div>`).join("")}</div>`;
}
