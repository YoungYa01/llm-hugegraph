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
    const llmCandidate = llmDecision.selected_candidate || top.candidate || "尚未形成判断";
    const llmReasons = normalizedReasonItems(
      llmDecision.most_likely_reasons,
      llmDecision.most_likely_reason || top.summary || analysis.decision || "暂无可展示的最可能原因",
    );
    const llmSteps = llmDecision.troubleshooting_methods?.length
      ? llmDecision.troubleshooting_methods
      : (top.validation_suggestions || []).map((item) => item.title || item.reason || item.check_id).filter(Boolean);
    const llmConfidence = llmDecision.confidence || top.confidence;
    const nodesCount = fusionGraph.nodes?.length || 0;
    const adaptiveCanvasHeight = Math.min(460, Math.max(240, 210 + Math.ceil(nodesCount * 8)));
    const pathStepsHtml = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 10px;flex-shrink:0">
        <h3 style="font-size:12px;font-weight:700;margin-bottom:4px;color:var(--ink-800)">传播路径依据</h3>
        ${top.path_steps?.length ? stepsHtml(top.path_steps) : `<div style="color:var(--ink-500);font-size:12px;padding:2px 0">暂无传播路径依据</div>`}
      </div>
    `;

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
            <p>融合静态架构子图与 RCA 根因候选节点，右侧直接对照呈现图谱推导的故障传播路径与节点明细。</p>
          </div>
        </div>
        <div class="card-body">
          ${fusionError ? `<div class="notice notice-warning" style="margin-bottom:12px">融合图暂不可用：${escapeHtml(fusionError)}。下方持久化 RCA 结论仍可正常查看。</div>` : ""}
          ${fusionGraph.warnings?.length ? `<div class="notice notice-warning" style="margin-bottom:12px">${escapeHtml(fusionGraph.warnings.join("；"))}</div>` : ""}
          ${fusionGraph.nodes.length ? `
            <div style="display:grid;grid-template-columns: 1fr 340px;gap:20px" class="graph-grid-responsive">
              <!-- 左侧：可缩放、可拖拽的故障定位拓扑 -->
              <div class="graph-shell graph-shell-fusion">
                <div id="fusion-semantic-warning" class="notice notice-warning graph-semantic-warning" hidden></div>
                <div id="fusion-graph-canvas"></div>
                <div class="graph-toolbar">
                  <button class="button button-ghost button-small" id="fusion-zoom-out" title="缩小">−</button>
                  <button class="button button-ghost button-small" id="fusion-zoom-reset" title="复位画布">复位</button>
                  <button class="button button-ghost button-small" id="fusion-zoom-in" title="放大">＋</button>
                  <button class="button button-ghost button-small" id="fusion-relayout" title="清除节点固定位置并重新布局">重排</button>
                </div>
                <div class="graph-legend">${graphLegend(true, true)}</div>
              </div>
              <!-- 右侧：传播链、路径依据和选中元素说明 -->
              <div class="graph-side-panel" style="display:flex;flex-direction:column;gap:10px;background:var(--surface-soft);padding:10px;border-radius:8px;border:1px solid var(--border);height:600px;overflow:hidden">
                <!-- 卡片 1: 故障传播链 (带独立边框与内部滚动) -->
                <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 10px;flex-shrink:0">
                  <h3 style="font-size:12px;font-weight:700;margin-bottom:4px;color:var(--ink-800)">
                    故障传播链 (Propagation Chain)
                  </h3>
                  <div style="max-height:105px;overflow-y:auto;padding-right:2px">
                    ${chainHtml(chain, chainExpanded)}
                  </div>
                </div>

                <!-- 卡片 2: 路径依据蓝框 (带独立边框，不上下滚动) -->
                ${pathStepsHtml}

                <!-- 卡片 3: 节点/连线属性解析 (带独立边框，分配 max-height:190px 充裕自适应视口) -->
                <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px;margin-top:auto;flex:1;min-height:0;display:flex;flex-direction:column;max-height:190px">
                  <h3 style="font-size:12px;font-weight:700;margin-bottom:6px;color:var(--ink-800);flex-shrink:0">节点/连线属性解析</h3>
                  <div id="fusion-selection" style="font-size:12px;color:var(--ink-700);line-height:1.5;overflow-y:auto;flex:1;padding-right:2px">
                    点击左侧图谱中的节点或连线，在此处实时查看具体定位属性与依赖。
                  </div>
                </div>
              </div>
            </div>
          ` : `
            <div class="empty-state"><div class="empty-icon">◇</div><h3>尚未读取到融合子图</h3><p>请确认 HugeGraph 中仍保留该日志批次的动态节点。</p></div>
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
              <h3 style="font-size:14px;font-weight:700;margin-bottom:8px;color:var(--ink-700)">📊 评分依据权重</h3>
              ${listHtml(top.reasons, "暂时没有可展示的评分依据。")}

              <h3 style="font-size:14px;font-weight:700;margin-top:20px;margin-bottom:8px;color:var(--ink-700)">🔍 关键日志堆栈证据</h3>
              ${renderFormattedEvidence(top.evidence, detail.root_evidence)}

              <h3 style="font-size:14px;font-weight:700;margin-top:20px;margin-bottom:8px;color:var(--ink-700)">🛠️ 推荐验证项</h3>
              ${validationSuggestionsHtml(top.validation_suggestions || [])}

              ${top.missing_evidence?.length ? `
                <h3 style="font-size:14px;font-weight:700;margin-top:20px;margin-bottom:8px;color:var(--danger)">⚠️ 建议补充收集的证据</h3>
                <div class="notice notice-warning">${top.missing_evidence.map((item) => `<p style="margin:0 0 6px">• ${escapeHtml(item)}</p>`).join("")}</div>
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
              ${timelineHtml(detail.timeline || [])}
            </div>
          </section>

          <!-- 3. 其他候选 (如果有) -->
          ${hypotheses.length > 1 ? `
            <section class="card">
              <div class="card-header">
                <div>
                  <h2>备选根因候选 (Top-2 ~ Top-N)</h2>
                  <p>主要证据不充足时，建议核查以下备选服务/组件。</p>
                </div>
              </div>
              <div class="card-body flush">
                ${hypothesesTable(hypotheses.slice(1))}
              </div>
            </section>
          ` : ""}
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
    if (!canvas || !fusionGraph.nodes.length) return;
    const decision = incident.analysis?.llm_decision || {};
    const hypothesis = selectedHypothesis(incident.analysis?.hypotheses || [], decision);
    const friendlyChain = normalizedDisplayChain(
      decision.propagation_path || decision.display_chain,
      hypothesis?.chain || [],
    );
    const friendlyByNode = new Map(friendlyChain.map((item) => [item.node, item]));
    graphController = renderGraph(canvas, fusionGraph, {
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
    const semanticWarning = content.querySelector("#fusion-semantic-warning");
    const warnings = [
      ...(graphController?.semantics?.warnings || []),
      ...(Array.isArray(decision.path_validation_warnings) ? decision.path_validation_warnings : []),
    ];
    if (semanticWarning && warnings.length) {
      semanticWarning.hidden = false;
      semanticWarning.textContent = warnings.join("；");
    }
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

  return `<div class="chain-vertical" style="display:flex;flex-direction:column;max-height:220px;overflow-y:auto;padding-right:4px;gap:0">${nodes}</div>${collapse}`;
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

function stepsHtml(steps) {
  if (!steps?.length) return "";
  const rows = steps.map((step) => `<div style="line-height:1.4;margin-bottom:3px">${escapeHtml(step.source)} → ${escapeHtml(step.target)} <small style="color:var(--ink-500)">(${escapeHtml(step.basis || step.relation)})</small></div>`);
  if (rows.length <= 6) return `<div class="notice" style="margin:0;padding:6px 8px;font-size:11px">${rows.join("")}</div>`;
  return `<details class="collapsible-details" style="margin:0;font-size:11px"><summary style="padding:4px 6px">展开 ${rows.length} 个路径依据</summary><div class="notice" style="margin:4px;padding:6px">${rows.join("")}</div></details>`;
}

function listHtml(items, fallback) {
  const values = items?.length ? items : [fallback];
  return `<ul class="evidence-list">${values.map((item) => `<li class="evidence-item">${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderFormattedEvidence(evidenceList, fallbackRaw) {
  const items = evidenceList?.length ? evidenceList : (fallbackRaw ? [fallbackRaw] : []);
  if (!items.length) return `<p style="color:var(--ink-500)">没有独立的结构化日志证据。</p>`;
  return `<div class="evidence-code-blocks">${items.map((item) => `
    <div style="margin-bottom:10px">
      <pre style="background:#1e293b;color:#f8fafc;padding:12px 14px;border-radius:8px;font-family:Consolas,Monaco,monospace;font-size:12px;line-height:1.5;overflow-x:auto;white-space:pre-wrap;word-break:break-all"><code>${escapeHtml(String(item))}</code></pre>
    </div>
  `).join("")}</div>`;
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
