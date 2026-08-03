import { api } from "../api.js";
import { graphLegend, renderGraph } from "../graph-view.js";
import { projectShell } from "../shell.js";
import { badge, emptyState, errorState, escapeHtml, formatDate, loading, setBusy, toast } from "../ui.js";
import { taskManager } from "../taskManager.js";

const archCache = {};

export async function renderArchitecturePage(root, project) {
  root.innerHTML = projectShell(project, "architecture", `<div id="page-content"></div>`);
  const content = root.querySelector("#page-content");
  let graph = archCache[project.id]?.graph || { nodes: [], edges: [], warnings: [] };
  let imports = archCache[project.id]?.imports || [];
  let selectedNode = null;
  let selectedEdge = null;
  let controller = null;

  let selectedNodeNames = new Set();
  let selectedEdgeKeys = new Set();
  let selectedArchitectureFile = null;

  function inPageTaskCardHtml() {
    const activeTask = taskManager.getTaskByType("architecture");
    if (!activeTask) return "";
    const pct = activeTask.progress || 0;
    return `
      <div class="tech-task-card" style="background:linear-gradient(135deg, #f8fafc 0%, #edf2f7 100%);border:1px solid #cbd5e1;border-left:4px solid #2563eb;border-radius:12px;padding:18px 22px;margin-bottom:24px;box-shadow:0 10px 25px -5px rgba(37,99,235,0.1);position:relative;overflow:hidden">
        <div class="tech-task-header" style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px">
          <div class="tech-task-title-group" style="display:flex;align-items:center;gap:12px">
            <div style="width:12px;height:12px;border-radius:50%;background:#2563eb;box-shadow:0 0 10px #3b82f6;display:inline-block;flex-shrink:0"></div>
            <div>
              <div class="tech-task-title" style="font-size:15px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:8px">
                架构大模型抽取处理中
                <span class="tech-task-tag" style="font-size:11px;font-weight:600;color:#2563eb;background:#dbeafe;padding:2px 8px;border-radius:6px;border:1px solid rgba(37,99,235,0.2)">${escapeHtml(activeTask.filename || activeTask.task_name)}</span>
              </div>
              <div class="tech-task-subtitle" style="font-size:12px;color:#64748b;margin-top:2px">后台线程独立运行中 · 离开本页或切换操作不会中断</div>
            </div>
          </div>
          <div class="tech-task-percent-badge" style="font-family:monospace,Consolas;font-size:22px;font-weight:800;color:#2563eb">${pct}%</div>
        </div>

        <div class="tech-progress-bar-outer" style="width:100%;height:14px;background:#cbd5e1;border-radius:999px;padding:2px;overflow:hidden;margin-bottom:14px;box-shadow:inset 0 1px 3px rgba(0,0,0,0.12)">
          <div class="tech-progress-bar-inner" style="width:${pct}%;height:100%;background:linear-gradient(90deg, #3b82f6 0%, #6366f1 50%, #8b5cf6 100%);border-radius:999px;transition:width 0.4s ease;box-shadow:0 2px 10px rgba(99,102,241,0.45)"></div>
        </div>

        <div class="tech-task-footer" style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div class="tech-task-status-text" style="font-size:13px;color:#334155;font-weight:500;display:flex;align-items:center;gap:6px">
            <span>⚡</span>
            <span>${escapeHtml(activeTask.progress_message || '正在处理...')}</span>
          </div>
          <div class="tech-task-steps" style="display:flex;align-items:center;gap:6px">
            <span style="font-size:11px;padding:3px 8px;border-radius:6px;background:${pct >= 5 ? '#dbeafe' : '#f1f5f9'};color:${pct >= 5 ? '#1e40af' : '#94a3b8'};font-weight:${pct >= 5 ? '600' : '400'};border:1px solid ${pct >= 5 ? '#93c5fd' : '#e2e8f0'}">1. 准备文件</span>
            <span style="color:#cbd5e1;font-size:11px">›</span>
            <span style="font-size:11px;padding:3px 8px;border-radius:6px;background:${pct >= 20 ? '#dbeafe' : '#f1f5f9'};color:${pct >= 20 ? '#1e40af' : '#94a3b8'};font-weight:${pct >= 20 ? '600' : '400'};border:1px solid ${pct >= 20 ? '#93c5fd' : '#e2e8f0'}">2. LLM 抽取</span>
            <span style="color:#cbd5e1;font-size:11px">›</span>
            <span style="font-size:11px;padding:3px 8px;border-radius:6px;background:${pct >= 75 ? '#dbeafe' : '#f1f5f9'};color:${pct >= 75 ? '#1e40af' : '#94a3b8'};font-weight:${pct >= 75 ? '600' : '400'};border:1px solid ${pct >= 75 ? '#93c5fd' : '#e2e8f0'}">3. HugeGraph 建图</span>
            <span style="color:#cbd5e1;font-size:11px">›</span>
            <span style="font-size:11px;padding:3px 8px;border-radius:6px;background:${pct >= 95 ? '#dbeafe' : '#f1f5f9'};color:${pct >= 95 ? '#1e40af' : '#94a3b8'};font-weight:${pct >= 95 ? '600' : '400'};border:1px solid ${pct >= 95 ? '#93c5fd' : '#e2e8f0'}">4. 完成快照</span>
          </div>
        </div>
      </div>
    `;
  }

  function toggleGraphLoadingOverlay(show, text = "正在同步最新拓扑数据…") {
    const wrapper = content.querySelector("#graph-shell-wrapper") || content.querySelector(".architecture-graph-card .card-body");
    if (!wrapper) return;
    let overlay = wrapper.querySelector("#graph-loading-overlay");
    if (show) {
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "graph-loading-overlay";
        overlay.style.cssText = "position:absolute;inset:0;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(255,255,255,0.85);backdrop-filter:blur(5px);border-radius:12px;box-shadow:inset 0 0 20px rgba(59,130,246,0.1)";
        overlay.innerHTML = `
          <div class="spinner" style="width:34px;height:34px;border-width:3px"></div>
          <div style="font-size:14px;font-weight:650;color:#1e40af;display:flex;align-items:center;gap:8px">
            <span>⚡</span>
            <span>${escapeHtml(text)}</span>
          </div>
        `;
        if (getComputedStyle(wrapper).position === "static") {
          wrapper.style.position = "relative";
        }
        wrapper.appendChild(overlay);
      } else {
        const textSpan = overlay.querySelector("span:last-child");
        if (textSpan) textSpan.textContent = text;
      }
    } else {
      overlay?.remove();
    }
  }

  async function refreshSilently() {
    try {
      const [graphData, importData] = await Promise.all([
        api.graph(project.id),
        api.architectures(project.id),
      ]);
      archCache[project.id] = { graph: graphData, imports: importData.items || [] };
      const changed = graph.nodes.length !== graphData.nodes.length || graph.edges.length !== graphData.edges.length;
      graph = graphData;
      imports = importData.items || [];
      const hasFileSelected = content.querySelector('input[name="file"]')?.files?.length > 0;
      if (changed && !hasFileSelected) paint();
    } catch (_) {
      // Ignore background refresh errors
    }
  }

  async function load() {
    if (!archCache[project.id]) {
      content.innerHTML = loading("正在读取架构图谱…");
    }
    try {
      const [graphData, importData] = await Promise.all([
        api.graph(project.id),
        api.architectures(project.id),
      ]);
      graph = graphData;
      imports = importData.items || [];
      archCache[project.id] = { graph, imports };
      selectedNodeNames.clear();
      selectedEdgeKeys.clear();
      paint();
    } catch (error) {
      if (!archCache[project.id]) {
        content.innerHTML = errorState(error, "retry-architecture");
        content.querySelector("#retry-architecture")?.addEventListener("click", load);
      }
    } finally {
      toggleGraphLoadingOverlay(false);
    }
  }

  if (archCache[project.id]) {
    paint();
    refreshSilently();
  } else {
    load();
  }

  function paint() {
    selectedNode = null;
    selectedEdge = null;
    content.innerHTML = `
      <div class="page-header">
        <div><h1>系统架构拓扑</h1><p>这里只展示静态系统架构；故障、日志事件和 RCA 节点仅在具体故障详情中融合展示。</p></div>
        <div class="page-actions" style="gap:8px;display:flex;flex-wrap:wrap">
          <button class="button button-secondary" id="export-graph-json"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>导出架构数据</button>
          <label class="button button-secondary" style="margin:0;cursor:pointer"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>导入图谱数据<input type="file" id="import-json-file" accept=".json" style="display:none" /></label>
          <button class="button button-secondary" id="add-node">＋ 新增节点</button>
          <button class="button button-primary" id="add-edge">＋ 新增关系</button>
        </div>
      </div>

      <details class="card architecture-import" style="margin-bottom:20px" ${graph.nodes.length === 0 || taskManager.hasActiveTask("architecture") ? "open" : ""}>
        <summary><span><strong>从架构描述文本增量抽取 (LLM 大模型)</strong><small>使用本地 Qwen 大模型增量抽取节点与依赖关系</small></span><span>展开上传 ▾</span></summary>
        <div class="card-body">
          <div id="architecture-task-container">${inPageTaskCardHtml()}</div>
          <form id="architecture-form" class="form-row" style="align-items:end">
            <div class="field"><label>架构文本文件</label><div class="file-drop" style="min-height:105px;position:relative"><input type="file" id="architecture-file-input" name="file" accept=".txt,.md,text/plain,text/markdown" style="position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;z-index:2" /><strong id="architecture-file-label">点击选择架构描述</strong><span>支持 UTF-8 的 .md / .txt</span></div></div>
            <div class="form-stack"><div class="field"><label for="architecture-name">版本名称（可选）</label><input class="input" id="architecture-name" name="name" maxlength="120" placeholder="例如：生产环境 v2" /></div><button class="button button-primary" id="import-architecture" type="submit" ${taskManager.hasActiveTask("architecture") ? "disabled" : ""}>${taskManager.hasActiveTask("architecture") ? "后台处理中..." : "大模型抽取并更新图谱"}</button></div>
          </form>
        </div>
      </details>

      <section class="card architecture-graph-card" style="margin-bottom:20px">
        <div class="card-header"><div><h2>架构拓扑</h2><p>${graph.nodes.length} 个架构节点 · ${graph.edges.length} 条架构关系；点击节点或连线可直接管理。</p></div><button class="button button-secondary button-small" id="refresh-graph">刷新</button></div>
        <div class="card-body">
          ${graph.warnings?.length ? `<div class="notice notice-warning" style="margin-bottom:12px">${escapeHtml(graph.warnings.join("；"))}</div>` : ""}
          ${graph.nodes.length ? `<div class="architecture-canvas-layout">
            <div class="graph-shell graph-shell-primary" id="graph-shell-wrapper"><div id="graph-canvas"></div><div class="graph-quick-actions" id="graph-quick-actions"><strong>点选节点或关系</strong><span>选中后可在这里直接编辑、删除</span></div><div class="graph-toolbar"><button class="button button-ghost button-small" id="toggle-fullscreen" title="全屏查看图谱">⛶ 全屏</button><button class="button button-ghost button-small" id="zoom-out">−</button><button class="button button-ghost button-small" id="zoom-reset">复位</button><button class="button button-ghost button-small" id="zoom-in">＋</button></div><div class="graph-legend">${graphLegend(false)}</div></div>
            <aside class="graph-selection-panel"><div id="selection-inspector">${selectionHtml()}</div></aside>
          </div>` : emptyState("架构图谱还是空的", "导入架构描述，或手工新增第一个架构节点。", '<button class="button button-primary" id="empty-add-node">新增节点</button>')}
        </div>
      </section>

      <div class="grid grid-2" style="margin-bottom:20px">
        <section class="card">
          <div class="card-header">
            <div><h2>节点管理</h2><p>编辑名称、类型、层级和描述。</p></div>
            <div style="display:flex;gap:8px">
              <button class="button button-danger button-small" id="batch-delete-nodes-btn" ${selectedNodeNames.size === 0 ? "disabled" : ""}>批量删除 (${selectedNodeNames.size})</button>
              <button class="button button-secondary button-small" id="table-add-node">＋ 节点</button>
            </div>
          </div>
          <div class="card-body flush management-table">${nodesTable(graph.nodes, selectedNodeNames)}</div>
        </section>

        <section class="card">
          <div class="card-header">
            <div><h2>关系管理</h2><p>维护依赖方向、关系类型和说明。</p></div>
            <div style="display:flex;gap:8px">
              <button class="button button-danger button-small" id="batch-delete-edges-btn" ${selectedEdgeKeys.size === 0 ? "disabled" : ""}>批量删除 (${selectedEdgeKeys.size})</button>
              <button class="button button-secondary button-small" id="table-add-edge">＋ 关系</button>
            </div>
          </div>
          <div class="card-body flush management-table">${edgesTable(graph.edges, selectedEdgeKeys)}</div>
        </section>
      </div>

      <section class="card"><div class="card-header"><div><h2>架构抽取历史</h2><p>保留大模型每次抽取的统计记录。</p></div></div><div class="card-body flush">${importsTable(imports)}</div></section>`;

    bind();
    if (graph.nodes.length) {
      controller = renderGraph(content.querySelector("#graph-canvas"), graph, {
        onSelect: (node, edges) => {
          selectedNode = node;
          selectedEdge = null;
          updateInspector(nodeInspectorHtml(node, edges));
          updateQuickActions("node", node);
        },
        onSelectEdge: (edge) => {
          selectedNode = null;
          selectedEdge = edge;
          updateInspector(edgeInspectorHtml(edge));
          updateQuickActions("edge", edge);
        },
      });
    }
  }

  function updateInspector(html) {
    const inspector = content.querySelector("#selection-inspector");
    if (!inspector) return;
    inspector.innerHTML = html;
    bindInspector(inspector);
  }

  function updateQuickActions(type, item) {
    const actions = content.querySelector("#graph-quick-actions");
    if (!actions) return;
    if (type === "node") {
      actions.innerHTML = `<div><small>已选择架构节点</small><strong>${escapeHtml(item.name)}</strong></div><div class="row-actions"><button class="button button-secondary button-small" id="quick-edit-node">编辑</button><button class="button button-danger button-small" id="quick-delete-node">删除</button></div>`;
      actions.querySelector("#quick-edit-node")?.addEventListener("click", () => showNodeModal(selectedNode));
      actions.querySelector("#quick-delete-node")?.addEventListener("click", () => deleteNode(selectedNode));
    } else {
      actions.innerHTML = `<div><small>已选择架构关系</small><strong>${escapeHtml(item.source)} —[${escapeHtml(item.type)}]→ ${escapeHtml(item.target)}</strong></div><div class="row-actions"><button class="button button-secondary button-small" id="quick-edit-edge">编辑</button><button class="button button-danger button-small" id="quick-delete-edge">删除</button></div>`;
      actions.querySelector("#quick-edit-edge")?.addEventListener("click", () => showEdgeModal(selectedEdge));
      actions.querySelector("#quick-delete-edge")?.addEventListener("click", () => deleteEdge(selectedEdge));
    }
  }

  function bind() {
    content.querySelector("#zoom-in")?.addEventListener("click", () => controller?.zoomIn());
    content.querySelector("#zoom-out")?.addEventListener("click", () => controller?.zoomOut());
    content.querySelector("#zoom-reset")?.addEventListener("click", () => controller?.reset());
    
    // 全屏大图模式切换 (支持 HTML5 原生 Fullscreen API + 动态内联式强制覆写 + 退出双向平移归位)
    const handleExitFullscreen = () => {
      const shell = content.querySelector("#graph-shell-wrapper");
      const svgEl = shell?.querySelector("svg");
      if (shell) {
        shell.classList.remove("is-fullscreen");
        if (svgEl) {
          svgEl.style.removeProperty("height");
          svgEl.style.removeProperty("max-height");
        }
        const btn = content.querySelector("#toggle-fullscreen");
        if (btn) btn.textContent = "⛶ 全屏";
      }
      controller?.reset(); // 退出全屏时自动清空全屏下的拖拽偏移，100% 优雅归位
    };

    const handleEnterFullscreen = () => {
      const shell = content.querySelector("#graph-shell-wrapper");
      const svgEl = shell?.querySelector("svg");
      if (shell) {
        shell.classList.add("is-fullscreen");
        if (svgEl) {
          svgEl.style.height = "100vh";
          svgEl.style.maxHeight = "100vh";
        }
        const btn = content.querySelector("#toggle-fullscreen");
        if (btn) btn.textContent = "✕ 退出全屏";
        if (shell.requestFullscreen) {
          shell.requestFullscreen().catch(() => {});
        }
      }
      controller?.reset();
    };

    content.querySelector("#toggle-fullscreen")?.addEventListener("click", () => {
      const shell = content.querySelector("#graph-shell-wrapper");
      if (!shell) return;
      if (document.fullscreenElement || shell.classList.contains("is-fullscreen")) {
        document.exitFullscreen?.().catch(() => {});
        handleExitFullscreen();
      } else {
        handleEnterFullscreen();
        toast("已开启 100% 沉浸全屏模式，再次点击或按 Esc 退出", "info");
      }
    });

    document.addEventListener("fullscreenchange", () => {
      const isFull = !!document.fullscreenElement;
      if (!isFull) {
        handleExitFullscreen();
      } else {
        handleEnterFullscreen();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const shell = content.querySelector("#graph-shell-wrapper");
        if (shell?.classList.contains("is-fullscreen")) {
          if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
          shell.classList.remove("is-fullscreen");
          const btn = content.querySelector("#toggle-fullscreen");
          if (btn) btn.textContent = "⛶ 全屏";
        }
      }
    });

    content.querySelector("#refresh-graph")?.addEventListener("click", load);
    content.querySelector("#zoom-out")?.addEventListener("click", () => controller?.zoomOut());
    content.querySelector("#zoom-reset")?.addEventListener("click", () => controller?.reset());
    content.querySelectorAll("#add-node, #table-add-node, #empty-add-node").forEach((button) => button.addEventListener("click", () => showNodeModal()));
    content.querySelectorAll("#add-edge, #table-add-edge").forEach((button) => button.addEventListener("click", () => showEdgeModal()));

    // 1. 导出架构数据 JSON 逻辑
    content.querySelector("#export-graph-json")?.addEventListener("click", async () => {
      try {
        const data = await api.exportGraph(project.id);
        const jsonStr = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `architecture_export_${project.name || project.id}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toast("架构图谱数据已成功导出为 JSON");
      } catch (error) {
        toast(`导出失败：${error.message}`, "error");
      }
    });

    // 2. 导入架构数据 JSON 逻辑 (直接存库，跳过大模型抽取)
    content.querySelector("#import-json-file")?.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const jsonPayload = JSON.parse(text);
        if (!jsonPayload || (typeof jsonPayload !== "object")) {
          throw new Error("无效的 JSON 数据结构");
        }
        toast("正在直接导入图谱数据…", "info");
        const res = await api.importGraphData(project.id, jsonPayload);
        graph = res.graph;
        toast(`直接导入成功！已保存 ${res.imported_nodes} 个节点与 ${res.imported_edges} 条关系（未经过 LLM，秒级同步）`);
        paint();
      } catch (error) {
        toast(`导入失败：${error.message}`, "error");
      } finally {
        event.target.value = "";
      }
    });

    // 3. 节点多选框绑定与批量删除 (按钮呈现旋转 Spinner)
    content.querySelector("#select-all-nodes")?.addEventListener("change", (e) => {
      const checked = e.target.checked;
      if (checked) {
        graph.nodes.forEach((n) => selectedNodeNames.add(n.name));
      } else {
        selectedNodeNames.clear();
      }
      paint();
    });

    content.querySelectorAll(".node-select-item").forEach((box) => {
      box.addEventListener("change", (e) => {
        const name = e.target.dataset.nodeName;
        if (e.target.checked) selectedNodeNames.add(name);
        else selectedNodeNames.delete(name);
        paint();
      });
    });

    content.querySelector("#batch-delete-nodes-btn")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const count = selectedNodeNames.size;
      if (count === 0) return;
      if (!window.confirm(`确认批量删除选中的 ${count} 个节点吗？\n与这些节点相关的所有依赖关系边也会被一并级联清理！该操作不可撤销。`)) return;
      
      const names = Array.from(selectedNodeNames);
      setBusy(btn, true, "删除中…");

      try {
        const res = await api.batchDeleteNodes(project.id, names);
        graph = res.graph;
        selectedNodeNames.clear();
        toast(`批量删除成功：已级联清理 ${res.deleted_nodes} 个节点及其相连关系边`);
        paint();
      } catch (error) {
        toast(`删除失败：${error.message}`, "error");
        setBusy(btn, false);
      }
    });

    // 4. 关系多选框绑定与批量删除 (按钮呈现旋转 Spinner)
    content.querySelector("#select-all-edges")?.addEventListener("change", (e) => {
      const checked = e.target.checked;
      if (checked) {
        graph.edges.forEach((edge) => selectedEdgeKeys.add(`${edge.source}|${edge.target}|${edge.type}`));
      } else {
        selectedEdgeKeys.clear();
      }
      paint();
    });

    content.querySelectorAll(".edge-select-item").forEach((box) => {
      box.addEventListener("change", (e) => {
        const key = e.target.dataset.edgeKey;
        if (e.target.checked) selectedEdgeKeys.add(key);
        else selectedEdgeKeys.delete(key);
        paint();
      });
    });

    content.querySelector("#batch-delete-edges-btn")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const count = selectedEdgeKeys.size;
      if (count === 0) return;
      if (!window.confirm(`确认批量删除选中的 ${count} 条架构关系连线吗？`)) return;

      const payloadEdges = Array.from(selectedEdgeKeys).map((k) => {
        const [source, target, type] = k.split("|");
        return { source, target, type };
      });
      setBusy(btn, true, "删除中…");

      try {
        const res = await api.batchDeleteEdges(project.id, payloadEdges);
        graph = res.graph;
        selectedEdgeKeys.clear();
        toast(`批量删除关系成功：已清理 ${res.deleted_edges} 条架构关系`);
        paint();
      } catch (error) {
        toast(`删除失败：${error.message}`, "error");
        setBusy(btn, false);
      }
    });

    content.querySelectorAll("[data-edit-node]").forEach((button) => button.addEventListener("click", () => showNodeModal(graph.nodes[Number(button.dataset.editNode)])));
    content.querySelectorAll("[data-delete-node]").forEach((button) => button.addEventListener("click", async (e) => {
      const node = graph.nodes[Number(button.dataset.deleteNode)];
      if (node) {
        setBusy(e.currentTarget, true, "删除中…");
        deleteNode(node);
      }
    }));
    content.querySelectorAll("[data-edit-edge]").forEach((button) => button.addEventListener("click", () => showEdgeModal(graph.edges[Number(button.dataset.editEdge)])));
    content.querySelectorAll("[data-delete-edge]").forEach((button) => button.addEventListener("click", async (e) => {
      const edge = graph.edges[Number(button.dataset.deleteEdge)];
      if (edge) {
        setBusy(e.currentTarget, true, "删除中…");
        deleteEdge(edge);
      }
    }));

    const fileInput = content.querySelector('input[name="file"]');
    fileInput?.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (file) {
        selectedArchitectureFile = file;
        const label = content.querySelector("#architecture-file-label");
        if (label) label.textContent = file.name;
      }
    });

    content.querySelector("#architecture-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = content.querySelector("#import-architecture");
      const file = selectedArchitectureFile || content.querySelector('input[name="file"]')?.files?.[0];
      if (!file) {
        toast("请选择有效的架构描述文件 (.md / .txt)", "error");
        return;
      }

      const form = new FormData();
      form.append("file", file);
      const nameVal = content.querySelector("#architecture-name")?.value;
      if (nameVal) form.append("name", nameVal);

      setBusy(button, true, "正在启动后台任务…");
      try {
        await api.importArchitecture(project.id, form);
        toast("架构大模型抽取任务已在后台启动！您可以自由切换页面。", "info");
        selectedArchitectureFile = null;
        await taskManager.pollNow();
        const el = content.querySelector("#architecture-task-container");
        if (el) el.innerHTML = inPageTaskCardHtml();
        button.disabled = true;
        button.textContent = "后台处理中...";
        setBusy(button, false);
      } catch (error) {
        toast(error.message, "error");
        setBusy(button, false);
      }
    });

    const onTaskUpdate = () => {
      const el = content.querySelector("#architecture-task-container");
      if (el) el.innerHTML = inPageTaskCardHtml();
    };
    const onTaskComplete = async (e) => {
      if (e.detail?.type === "architecture") {
        toggleGraphLoadingOverlay(true, "⚡ 架构大模型抽取完成，正在同步并渲染最新拓扑图谱…");
        delete archCache[project.id];
        await load();
      }
    };
    taskManager.addEventListener("task:updated", onTaskUpdate);
    taskManager.addEventListener("task:completed", onTaskComplete);
  }

  function bindInspector(inspector) {
    inspector.querySelector("#edit-selected-node")?.addEventListener("click", () => showNodeModal(selectedNode));
    inspector.querySelector("#delete-selected-node")?.addEventListener("click", () => deleteNode(selectedNode));
    inspector.querySelector("#edit-selected-edge")?.addEventListener("click", () => showEdgeModal(selectedEdge));
    inspector.querySelector("#delete-selected-edge")?.addEventListener("click", () => deleteEdge(selectedEdge));
  }

  async function deleteNode(node) {
    if (!node || !window.confirm(`删除节点“${node.name}”及其全部相邻关系？该操作不可恢复。`)) return;
    try {
      const result = await api.deleteNode(project.id, node.name);
      graph = result.graph;
      toast("节点及相邻关系已删除");
      paint();
    } catch (error) { toast(error.message, "error"); }
  }

  async function deleteEdge(edge) {
    if (!edge || !window.confirm(`删除关系“${edge.source} —[${edge.type}]→ ${edge.target}”？`)) return;
    try {
      const result = await api.deleteEdge(project.id, {
        source: edge.source,
        target: edge.target,
        type: edge.type,
      });
      if (!result.deleted) throw new Error("关系不存在或已被删除");
      graph = result.graph;
      toast("关系已删除");
      paint();
    } catch (error) { toast(error.message, "error"); }
  }

  function showNodeModal(node = null) {
    const modal = modalElement(node ? "编辑架构节点" : "新增架构节点", `<form class="form-stack" id="node-form">
      <div class="field"><label>名称</label><input class="input" name="name" required maxlength="180" value="${escapeHtml(node?.name || "")}" /></div>
      <div class="form-row"><div class="field"><label>类型 kind</label><input class="input" name="kind" required value="${escapeHtml(node?.kind || "Service")}" list="kind-options" /><datalist id="kind-options"><option>System</option><option>Service</option><option>API</option><option>Database</option><option>Cache</option><option>Queue</option><option>Middleware</option><option>Cluster</option><option>Instance</option><option>Host</option><option>Pod</option><option>Component</option></datalist></div><div class="field"><label>层级 layer</label><input class="input" name="layer" value="${escapeHtml(node?.layer || "业务服务层")}" /></div></div>
      <div class="field"><label>描述</label><textarea class="textarea" name="description">${escapeHtml(node?.description || "")}</textarea></div>
      <div class="field"><label>元数据 JSON</label><textarea class="textarea" name="meta" placeholder='例如 {"host":"10.0.0.12","port":"6379","aliases":["redis-1"]}'>${node ? escapeHtml(JSON.stringify(node.meta || {}, null, 2)) : "{}"}</textarea><span class="field-hint">实例级根因需要 host / port / endpoints 等标识才能精确匹配。</span></div>
      ${node ? '<div class="notice">修改节点名称时，系统会迁移所有相邻架构关系和历史 RCA 关联，不会保留重复旧节点。</div>' : ""}
      <div style="display:flex;justify-content:flex-end;gap:9px"><button type="button" class="button button-secondary" data-close>取消</button><button class="button button-primary" id="save-node" type="submit">保存节点</button></div>
    </form>`);
    modal.querySelector("#node-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = modal.querySelector("#save-node");
      const values = Object.fromEntries(new FormData(event.currentTarget));
      try { values.meta = JSON.parse(values.meta || "{}"); } catch { toast("元数据必须是有效 JSON", "error"); return; }
      setBusy(button, true, "保存中…");
      try {
        const result = node
          ? await api.updateNode(project.id, node.name, values)
          : await api.createNode(project.id, values);
        graph = result.graph;
        modal.remove();
        toast(node ? "节点已更新" : "节点已创建");
        paint();
      } catch (error) { toast(error.message, "error"); setBusy(button, false); }
    });
  }

  function showEdgeModal(edge = null) {
    if (graph.nodes.length < 2) { toast("至少需要两个节点才能创建关系", "error"); return; }
    const options = graph.nodes.map((node) => `<option value="${escapeHtml(node.name)}">${escapeHtml(node.name)} · ${escapeHtml(node.kind)}</option>`).join("");
    const modal = modalElement(edge ? "编辑架构关系" : "新增架构关系", `<form class="form-stack" id="edge-form">
      <div class="field"><label>源节点（调用方/依赖方）</label><select class="select" name="source" required>${options}</select></div>
      <div class="field"><label>关系类型</label>
        <select class="select" name="type" required>
          <option value="CALLS" ${edge?.type === "CALLS" ? "selected" : ""}>CALLS · 微服务/接口服务间调用</option>
          <option value="DEPENDS_ON" ${!edge || edge?.type === "DEPENDS_ON" ? "selected" : ""}>DEPENDS_ON · 业务服务依赖组件/基础设施</option>
          <option value="USES_DB" ${edge?.type === "USES_DB" ? "selected" : ""}>USES_DB · 读写使用数据库或缓存</option>
          <option value="TRIGGERS" ${edge?.type === "TRIGGERS" ? "selected" : ""}>TRIGGERS · UI页面功能触发API接口</option>
          <option value="BELONGS_TO" ${edge?.type === "BELONGS_TO" ? "selected" : ""}>BELONGS_TO · 前端控件归属于页面功能</option>
          <option value="ROUTES_TO" ${edge?.type === "ROUTES_TO" ? "selected" : ""}>ROUTES_TO · API网关路由调度到后端微服务</option>
          <option value="RUNS_ON" ${edge?.type === "RUNS_ON" ? "selected" : ""}>RUNS_ON · 容器Pod实例承载运行微服务</option>
          <option value="HOSTED_ON" ${edge?.type === "HOSTED_ON" ? "selected" : ""}>HOSTED_ON · 容器/数据库托管部署在宿主机</option>
          <option value="CONNECTS_TO" ${edge?.type === "CONNECTS_TO" ? "selected" : ""}>CONNECTS_TO · 物理宿主机连接网络交换机</option>
          <option value="READS" ${edge?.type === "READS" ? "selected" : ""}>READS · 数据存储只读依赖关系</option>
          <option value="WRITES" ${edge?.type === "WRITES" ? "selected" : ""}>WRITES · 数据存储写入依赖关系</option>
          <option value="PUBLISHES" ${edge?.type === "PUBLISHES" ? "selected" : ""}>PUBLISHES · 消息队列发布事件</option>
          <option value="SUBSCRIBES" ${edge?.type === "SUBSCRIBES" ? "selected" : ""}>SUBSCRIBES · 消息队列订阅消费事件</option>
          <option value="HAS_MEMBER" ${edge?.type === "HAS_MEMBER" ? "selected" : ""}>HAS_MEMBER · 逻辑集群包含物理具体实例</option>
          <option value="CONTAINS" ${edge?.type === "CONTAINS" ? "selected" : ""}>CONTAINS · 系统分层/模块逻辑包含</option>
        </select>
      </div>
      <div class="field"><label>目标节点（被调用方/被依赖方）</label><select class="select" name="target" required>${options}</select></div>
      <div class="field"><label>说明</label><input class="input" name="description" value="${escapeHtml(edge?.description || "")}" placeholder="关系的业务语义或环境信息" /></div>
      <div class="field"><label>元数据 JSON</label><textarea class="textarea" name="meta">${escapeHtml(JSON.stringify(edge?.meta || {}, null, 2))}</textarea></div>
      <div class="notice">依赖边必须按“调用方 → 被依赖方”录入；根因页面会按相反方向展示故障传播。</div>
      <div style="display:flex;justify-content:flex-end;gap:9px"><button type="button" class="button button-secondary" data-close>取消</button><button class="button button-primary" id="save-edge" type="submit">保存关系</button></div>
    </form>`);
    const defaultSource = edge?.source || (selectedNode ? selectedNode.name : graph.nodes[0].name);
    const defaultTarget = edge?.target || (graph.nodes.find(n => n.name !== defaultSource)?.name || graph.nodes[1]?.name);
    sourceSelect.value = defaultSource;
    targetSelect.value = defaultTarget;
    modal.querySelector("#edge-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      if (values.source === values.target) { toast("源节点与目标节点不能相同", "error"); return; }
      try { values.meta = JSON.parse(values.meta || "{}"); } catch { toast("元数据必须是有效 JSON", "error"); return; }
      const button = modal.querySelector("#save-edge");
      setBusy(button, true, "保存中…");
      try {
        const result = edge
          ? await api.updateEdge(project.id, {
            original_source: edge.source,
            original_target: edge.target,
            original_type: edge.type,
            ...values,
          })
          : await api.createEdge(project.id, values);
        graph = result.graph;
        modal.remove();
        toast(edge ? "关系已更新" : "关系已创建");
        paint();
      } catch (error) { toast(error.message, "error"); setBusy(button, false); }
    });
  }

  await load();
}

function selectionHtml() {
  return `<div class="empty-compact"><div class="empty-icon">◇</div><h3>选择图中元素</h3><p>点击节点或连线后，可在这里查看、编辑或删除。</p></div>`;
}

function nodeInspectorHtml(node, edges) {
  return `<span class="badge">架构节点</span><h3 style="font-size:18px;margin:12px 0 4px">${escapeHtml(node.name)}</h3><p style="color:var(--ink-500)">${escapeHtml(node.kind)} · ${escapeHtml(node.layer || "未分层")}</p><p>${escapeHtml(node.description || "暂无描述")}</p><dl class="kv-list"><div class="kv-row"><dt>相邻关系</dt><dd>${edges.length}</dd></div><div class="kv-row"><dt>元数据</dt><dd><pre style="white-space:pre-wrap;margin:0">${escapeHtml(JSON.stringify(node.meta || {}, null, 2))}</pre></dd></div></dl><div class="inspector-actions"><button class="button button-secondary" id="edit-selected-node">编辑节点</button><button class="button button-danger" id="delete-selected-node">删除节点</button></div>`;
}

function edgeInspectorHtml(edge) {
  return `<span class="badge">架构关系</span><h3 style="font-size:17px;margin:12px 0">${escapeHtml(edge.source)}<br><span style="color:var(--brand)">—[${escapeHtml(edge.type)}]→</span><br>${escapeHtml(edge.target)}</h3><p>${escapeHtml(edge.description || "暂无关系说明")}</p><dl class="kv-list"><div class="kv-row"><dt>元数据</dt><dd><pre style="white-space:pre-wrap;margin:0">${escapeHtml(JSON.stringify(edge.meta || {}, null, 2))}</pre></dd></div></dl><div class="inspector-actions"><button class="button button-secondary" id="edit-selected-edge">编辑关系</button><button class="button button-danger" id="delete-selected-edge">删除关系</button></div>`;
}

function nodesTable(nodes, selectedNames) {
  if (!nodes.length) return emptyState("没有架构节点", "点击新增节点开始维护。 ");
  const allSelected = nodes.length > 0 && selectedNames.size === nodes.length;
  return `<div class="table-wrap"><table class="table"><thead><tr><th style="width:36px"><input type="checkbox" id="select-all-nodes" ${allSelected ? "checked" : ""} /></th><th>节点</th><th>类型</th><th>操作</th></tr></thead><tbody>${nodes.map((node, index) => {
    const isChecked = selectedNames.has(node.name);
    return `<tr data-node-row="${escapeHtml(node.name)}"><td><input type="checkbox" class="node-select-item" data-node-name="${escapeHtml(node.name)}" ${isChecked ? "checked" : ""} /></td><td><strong>${escapeHtml(node.name)}</strong><span class="table-subtitle">${escapeHtml(node.description || node.layer || "—")}</span></td><td><span class="badge">${escapeHtml(node.kind)}</span></td><td><div class="row-actions"><button class="button button-secondary button-small" data-edit-node="${index}">编辑</button><button class="button button-danger button-small" data-delete-node="${index}">删除</button></div></td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function edgesTable(edges, selectedKeys) {
  if (!edges.length) return emptyState("没有架构关系", "创建关系后 RCA 才能沿依赖图查找传播链。 ");
  const allSelected = edges.length > 0 && selectedKeys.size === edges.length;
  return `<div class="table-wrap"><table class="table"><thead><tr><th style="width:36px"><input type="checkbox" id="select-all-edges" ${allSelected ? "checked" : ""} /></th><th>关系</th><th>类型</th><th>操作</th></tr></thead><tbody>${edges.map((edge, index) => {
    const key = `${edge.source}|${edge.target}|${edge.type}`;
    const isChecked = selectedKeys.has(key);
    return `<tr data-edge-row="${escapeHtml(key)}"><td><input type="checkbox" class="edge-select-item" data-edge-key="${escapeHtml(key)}" ${isChecked ? "checked" : ""} /></td><td><strong>${escapeHtml(edge.source)} → ${escapeHtml(edge.target)}</strong><span class="table-subtitle">${escapeHtml(edge.description || "—")}</span></td><td><span class="badge">${escapeHtml(edge.type)}</span></td><td><div class="row-actions"><button class="button button-secondary button-small" data-edit-edge="${index}">编辑</button><button class="button button-danger button-small" data-delete-edge="${index}">删除</button></div></td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function importsTable(items) {
  if (!items.length) return emptyState("还没有导入记录", "上传一份架构描述后会保留版本和抽取统计。 ");
  return `<div class="table-wrap"><table class="table"><thead><tr><th>版本</th><th>来源</th><th>节点</th><th>关系</th><th>状态</th><th>完成时间</th></tr></thead><tbody>${items.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong>${item.error_message ? `<span class="table-subtitle">${escapeHtml(item.error_message)}</span>` : ""}</td><td>${escapeHtml(item.source_file)}</td><td>${item.extracted_nodes}</td><td>${item.extracted_edges}</td><td>${badge(item.status)}</td><td>${formatDate(item.completed_at || item.created_at)}</td></tr>`).join("")}</tbody></table></div>`;
}

function modalElement(title, body) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<section class="modal" role="dialog" aria-modal="true"><header class="modal-header"><h2>${escapeHtml(title)}</h2><button class="button button-ghost" data-close>✕</button></header><div class="modal-body">${body}</div></section>`;
  document.body.append(backdrop);
  backdrop.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => backdrop.remove()));
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) backdrop.remove(); });
  return backdrop;
}
