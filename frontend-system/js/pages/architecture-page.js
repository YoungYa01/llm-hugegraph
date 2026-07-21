import { api } from "../api.js";
import { graphLegend, renderGraph } from "../graph-view.js";
import { projectShell } from "../shell.js";
import { badge, emptyState, errorState, escapeHtml, formatDate, loading, setBusy, toast } from "../ui.js";

export async function renderArchitecturePage(root, project) {
  root.innerHTML = projectShell(project, "architecture", `<div id="page-content">${loading("正在读取架构图谱…")}</div>`);
  const content = root.querySelector("#page-content");
  let graph = { nodes: [], edges: [], warnings: [] };
  let imports = [];
  let selectedNode = null;
  let selectedEdge = null;
  let controller = null;

  async function load() {
    content.innerHTML = loading("正在读取架构图谱…");
    try {
      const [graphData, importData] = await Promise.all([
        api.graph(project.id),
        api.architectures(project.id),
      ]);
      graph = graphData;
      imports = importData.items || [];
      paint();
    } catch (error) {
      content.innerHTML = errorState(error, "retry-architecture");
      content.querySelector("#retry-architecture")?.addEventListener("click", load);
    }
  }

  function paint() {
    selectedNode = null;
    selectedEdge = null;
    content.innerHTML = `
      <div class="page-header">
        <div><h1>系统架构知识图谱</h1><p>这里只展示静态系统架构；故障、日志事件和 RCA 节点仅在具体故障详情中融合展示。</p></div>
        <div class="page-actions"><button class="button button-secondary" id="add-node">＋ 新增节点</button><button class="button button-primary" id="add-edge">＋ 新增关系</button></div>
      </div>

      <details class="card architecture-import" style="margin-bottom:20px">
        <summary><span><strong>导入架构描述</strong><small>使用本地 Qwen 增量抽取节点与依赖关系</small></span><span>展开上传 ▾</span></summary>
        <div class="card-body">
          <form id="architecture-form" class="form-row" style="align-items:end">
            <div class="field"><label>架构文本文件</label><label class="file-drop" style="min-height:105px"><input type="file" name="file" required accept=".txt,.md,text/plain,text/markdown" /><strong id="architecture-file-label">点击选择架构描述</strong><span>支持 UTF-8 的 .md / .txt</span></label></div>
            <div class="form-stack"><div class="field"><label for="architecture-name">版本名称（可选）</label><input class="input" id="architecture-name" name="name" maxlength="120" placeholder="例如：生产环境 v2" /></div><button class="button button-primary" id="import-architecture" type="submit">导入并更新图谱</button></div>
          </form>
        </div>
      </details>

      <section class="card architecture-graph-card" style="margin-bottom:20px">
        <div class="card-header"><div><h2>架构拓扑</h2><p>${graph.nodes.length} 个架构节点 · ${graph.edges.length} 条架构关系；点击节点或连线可直接管理。</p></div><button class="button button-secondary button-small" id="refresh-graph">刷新</button></div>
        <div class="card-body">
          ${graph.warnings?.length ? `<div class="notice notice-warning" style="margin-bottom:12px">${escapeHtml(graph.warnings.join("；"))}</div>` : ""}
          ${graph.nodes.length ? `<div class="architecture-canvas-layout">
            <div class="graph-shell graph-shell-primary"><div id="graph-canvas"></div><div class="graph-quick-actions" id="graph-quick-actions"><strong>点选节点或关系</strong><span>选中后可在这里直接编辑、删除</span></div><div class="graph-toolbar"><button class="button button-ghost button-small" id="zoom-out">−</button><button class="button button-ghost button-small" id="zoom-reset">复位</button><button class="button button-ghost button-small" id="zoom-in">＋</button></div><div class="graph-legend">${graphLegend(false)}</div></div>
            <aside class="graph-selection-panel"><div id="selection-inspector">${selectionHtml()}</div></aside>
          </div>` : emptyState("架构图谱还是空的", "导入架构描述，或手工新增第一个架构节点。", '<button class="button button-primary" id="empty-add-node">新增节点</button>')}
        </div>
      </section>

      <div class="grid grid-2" style="margin-bottom:20px">
        <section class="card"><div class="card-header"><div><h2>节点管理</h2><p>编辑名称、类型、层级、描述和实例标识。</p></div><button class="button button-secondary button-small" id="table-add-node">＋ 节点</button></div><div class="card-body flush management-table">${nodesTable(graph.nodes)}</div></section>
        <section class="card"><div class="card-header"><div><h2>关系管理</h2><p>维护依赖方向、关系类型和说明。</p></div><button class="button button-secondary button-small" id="table-add-edge">＋ 关系</button></div><div class="card-body flush management-table">${edgesTable(graph.edges)}</div></section>
      </div>

      <section class="card"><div class="card-header"><div><h2>架构导入记录</h2><p>保留每次抽取的结果数量和执行状态。</p></div></div><div class="card-body flush">${importsTable(imports)}</div></section>`;

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
    content.querySelector("#refresh-graph")?.addEventListener("click", load);
    content.querySelectorAll("#add-node, #table-add-node, #empty-add-node").forEach((button) => button.addEventListener("click", () => showNodeModal()));
    content.querySelectorAll("#add-edge, #table-add-edge").forEach((button) => button.addEventListener("click", () => showEdgeModal()));

    content.querySelectorAll("[data-edit-node]").forEach((button) => button.addEventListener("click", () => showNodeModal(graph.nodes[Number(button.dataset.editNode)])));
    content.querySelectorAll("[data-delete-node]").forEach((button) => button.addEventListener("click", () => deleteNode(graph.nodes[Number(button.dataset.deleteNode)])));
    content.querySelectorAll("[data-edit-edge]").forEach((button) => button.addEventListener("click", () => showEdgeModal(graph.edges[Number(button.dataset.editEdge)])));
    content.querySelectorAll("[data-delete-edge]").forEach((button) => button.addEventListener("click", () => deleteEdge(graph.edges[Number(button.dataset.deleteEdge)])));

    const fileInput = content.querySelector('input[name="file"]');
    fileInput?.addEventListener("change", () => {
      content.querySelector("#architecture-file-label").textContent = fileInput.files?.[0]?.name || "点击选择架构描述";
    });
    content.querySelector("#architecture-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = content.querySelector("#import-architecture");
      const form = new FormData(event.currentTarget);
      setBusy(button, true, "大模型抽取与写图中…");
      try {
        const data = await api.importArchitecture(project.id, form);
        graph = data.graph;
        imports = (await api.architectures(project.id)).items || [];
        toast(`架构已更新：${data.architecture.extracted_nodes} 节点 / ${data.architecture.extracted_edges} 关系`);
        paint();
      } catch (error) {
        toast(error.message, "error");
        setBusy(button, false);
      }
    });
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
      <div class="field"><label>关系类型</label><input class="input" name="type" required value="${escapeHtml(edge?.type || "DEPENDS_ON")}" list="relation-options" /><datalist id="relation-options"><option>CALLS</option><option>DEPENDS_ON</option><option>USES_DB</option><option>READS</option><option>WRITES</option><option>CONNECTS_TO</option><option>RUNS_ON</option><option>HAS_MEMBER</option><option>CONTAINS</option></datalist></div>
      <div class="field"><label>目标节点（被调用方/被依赖方）</label><select class="select" name="target" required>${options}</select></div>
      <div class="field"><label>说明</label><input class="input" name="description" value="${escapeHtml(edge?.description || "")}" placeholder="关系的业务语义或环境信息" /></div>
      <div class="field"><label>元数据 JSON</label><textarea class="textarea" name="meta">${escapeHtml(JSON.stringify(edge?.meta || {}, null, 2))}</textarea></div>
      <div class="notice">依赖边必须按“调用方 → 被依赖方”录入；根因页面会按相反方向展示故障传播。</div>
      <div style="display:flex;justify-content:flex-end;gap:9px"><button type="button" class="button button-secondary" data-close>取消</button><button class="button button-primary" id="save-edge" type="submit">保存关系</button></div>
    </form>`);
    const sourceSelect = modal.querySelector('select[name="source"]');
    const targetSelect = modal.querySelector('select[name="target"]');
    sourceSelect.value = edge?.source || graph.nodes[0].name;
    targetSelect.value = edge?.target || graph.nodes[1].name;
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

function nodesTable(nodes) {
  if (!nodes.length) return emptyState("没有架构节点", "点击新增节点开始维护。 ");
  return `<div class="table-wrap"><table class="table"><thead><tr><th>节点</th><th>类型</th><th>操作</th></tr></thead><tbody>${nodes.map((node, index) => `<tr><td><strong>${escapeHtml(node.name)}</strong><span class="table-subtitle">${escapeHtml(node.description || node.layer || "—")}</span></td><td><span class="badge">${escapeHtml(node.kind)}</span></td><td><div class="row-actions"><button class="button button-secondary button-small" data-edit-node="${index}">编辑</button><button class="button button-danger button-small" data-delete-node="${index}">删除</button></div></td></tr>`).join("")}</tbody></table></div>`;
}

function edgesTable(edges) {
  if (!edges.length) return emptyState("没有架构关系", "创建关系后 RCA 才能沿依赖图查找传播链。 ");
  return `<div class="table-wrap"><table class="table"><thead><tr><th>关系</th><th>类型</th><th>操作</th></tr></thead><tbody>${edges.map((edge, index) => `<tr><td><strong>${escapeHtml(edge.source)} → ${escapeHtml(edge.target)}</strong><span class="table-subtitle">${escapeHtml(edge.description || "—")}</span></td><td><span class="badge">${escapeHtml(edge.type)}</span></td><td><div class="row-actions"><button class="button button-secondary button-small" data-edit-edge="${index}">编辑</button><button class="button button-danger button-small" data-delete-edge="${index}">删除</button></div></td></tr>`).join("")}</tbody></table></div>`;
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
