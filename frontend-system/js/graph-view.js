const SVG_NS = "http://www.w3.org/2000/svg";

const palette = {
  Service: "#4568dc", API: "#5d7ce3", Component: "#6679aa", System: "#394a78",
  Database: "#11938f", Cache: "#13a5a0", Queue: "#7a62c8", Middleware: "#6975bd",
  Cluster: "#16817e", Instance: "#e68a35", Host: "#d1772d", Pod: "#de7d45",
  Incident: "#ce4052", RCAHypothesis: "#a848a8", LogEvent: "#c85c72", Exception: "#b93645", Trace: "#8b5baa",
};

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function groupFor(node) {
  if (["Incident", "RCAHypothesis", "LogEvent", "Exception", "Trace", "Window", "Metric"].includes(node.kind)) return 4;
  if (["Instance", "Host", "Pod"].includes(node.kind)) return 3;
  if (["Database", "Cache", "Queue", "Middleware", "Cluster"].includes(node.kind)) return 2;
  if (["Service", "Component", "Function"].includes(node.kind)) return 1;
  return 0;
}

function layout(nodes) {
  const groups = Array.from({ length: 5 }, () => []);
  nodes.forEach((node) => groups[groupFor(node)].push(node));
  groups.forEach((items) => items.sort((a, b) => a.name.localeCompare(b.name, "zh-CN")));
  const positions = new Map();
  let maxRows = 1;
  groups.forEach((items, column) => {
    maxRows = Math.max(maxRows, items.length);
    items.forEach((node, row) => positions.set(node.name, { x: 70 + column * 230, y: 70 + row * 84 }));
  });
  return { positions, width: 70 + 5 * 230, height: Math.max(650, 100 + maxRows * 84) };
}

function short(value, length = 20) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function renderGraph(
  container,
  graph,
  { onSelect = () => {}, onSelectEdge = () => {} } = {},
) {
  container.replaceChildren();
  const nodes = (graph.nodes || []).slice(0, 500);
  const nodeNames = new Set(nodes.map((node) => node.name));
  const edges = (graph.edges || []).filter((edge) => nodeNames.has(edge.source) && nodeNames.has(edge.target)).slice(0, 1200);
  if (!nodes.length) return null;

  const { positions, width, height } = layout(nodes);
  const svg = svgElement("svg", { role: "img", "aria-label": "项目知识图谱", viewBox: `0 0 ${width} ${height}` });
  const defs = svgElement("defs");
  const marker = svgElement("marker", { id: "arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" });
  marker.append(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#aeb8ca" }));
  defs.append(marker);
  svg.append(defs);
  const viewport = svgElement("g");
  svg.append(viewport);
  const edgeLayer = svgElement("g");
  const nodeLayer = svgElement("g");
  viewport.append(edgeLayer, nodeLayer);

  const visibleEdgePaths = () => edgeLayer.querySelectorAll("path[data-edge-visible]");

  let selectedEdge = null;
  edges.forEach((edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) return;
    const x1 = source.x + 150;
    const y1 = source.y + 27;
    const x2 = target.x;
    const y2 = target.y + 27;
    const bend = Math.max(40, Math.abs(x2 - x1) * 0.38);
    const pathData = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
    const hitPath = svgElement("path", {
      d: pathData, fill: "none", stroke: "transparent", "stroke-width": "14",
      "pointer-events": "stroke", tabindex: "0", role: "button",
      "aria-label": `关系：${edge.source} ${edge.type} ${edge.target}`,
    });
    const path = svgElement("path", {
      d: pathData,
      fill: "none", stroke: "#b9c2d2", "stroke-width": "1.25", "marker-end": "url(#arrow)",
      "pointer-events": "none", "data-edge-visible": "true",
    });
    [hitPath, path].forEach((candidate) => {
      candidate.dataset.source = edge.source;
      candidate.dataset.target = edge.target;
      candidate.dataset.type = edge.type;
    });
    hitPath.style.cursor = "pointer";
    const chooseEdge = (event) => {
      event.stopPropagation();
      if (selected) selected.setAttribute("stroke", "#d4dcea");
      selected = null;
      visibleEdgePaths().forEach((candidate) => {
        candidate.setAttribute("stroke", "#d3d9e4");
        candidate.setAttribute("stroke-width", "1");
        candidate.setAttribute("opacity", ".42");
      });
      selectedEdge = path;
      path.setAttribute("stroke", "#3157d5");
      path.setAttribute("stroke-width", "3");
      path.setAttribute("opacity", "1");
      onSelectEdge(edge);
    };
    hitPath.addEventListener("click", chooseEdge);
    hitPath.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") chooseEdge(event);
    });
    edgeLayer.append(hitPath, path);
    if (edges.length <= 55) {
      const label = svgElement("text", { x: String((x1 + x2) / 2), y: String((y1 + y2) / 2 - 6), "text-anchor": "middle", fill: "#8792a6", "font-size": "9" });
      label.textContent = short(edge.type, 18);
      label.style.pointerEvents = "none";
      edgeLayer.append(label);
    }
  });

  let selected = null;
  nodes.forEach((node) => {
    const pos = positions.get(node.name);
    const group = svgElement("g", {
      transform: `translate(${pos.x} ${pos.y})`, tabindex: "0", role: "button",
      "aria-label": `节点：${node.name}，类型：${node.kind || "Component"}`,
    });
    group.style.cursor = "pointer";
    const color = palette[node.kind] || "#64748b";
    const rect = svgElement("rect", { width: "150", height: "54", rx: "10", fill: "#fff", stroke: "#d4dcea", "stroke-width": "1.2" });
    const accent = svgElement("rect", { width: "5", height: "54", rx: "2.5", fill: color });
    const title = svgElement("text", { x: "15", y: "23", fill: "#17213a", "font-size": "12", "font-weight": "650" });
    title.textContent = short(node.name, 19);
    const kind = svgElement("text", { x: "15", y: "40", fill: "#7a8599", "font-size": "9.5" });
    kind.textContent = node.kind || "Component";
    const browserTitle = svgElement("title");
    browserTitle.textContent = `${node.name} · ${node.kind}\n${node.description || ""}`;
    group.append(rect, accent, title, kind, browserTitle);
    const choose = () => {
      if (selected) selected.setAttribute("stroke", "#d4dcea");
      selectedEdge = null;
      selected = rect;
      rect.setAttribute("stroke", color);
      rect.setAttribute("stroke-width", "2.5");
      visibleEdgePaths().forEach((path) => {
        const active = path.dataset.source === node.name || path.dataset.target === node.name;
        path.setAttribute("stroke", active ? color : "#d3d9e4");
        path.setAttribute("stroke-width", active ? "2.2" : "1");
        path.setAttribute("opacity", active ? "1" : ".42");
      });
      onSelect(node, edges.filter((edge) => edge.source === node.name || edge.target === node.name));
    };
    group.addEventListener("click", (event) => { event.stopPropagation(); choose(); });
    group.addEventListener("keydown", (event) => { if (event.key === "Enter") choose(); });
    nodeLayer.append(group);
  });

  let scale = 1;
  let panX = 0;
  let panY = 0;
  let dragging = false;
  let start = { x: 0, y: 0 };
  const transform = () => viewport.setAttribute("transform", `translate(${panX} ${panY}) scale(${scale})`);
  const zoom = (factor) => { scale = Math.max(0.35, Math.min(2.4, scale * factor)); transform(); };
  const reset = () => { scale = 1; panX = 0; panY = 0; transform(); };
  svg.addEventListener("wheel", (event) => { event.preventDefault(); zoom(event.deltaY < 0 ? 1.1 : 0.9); }, { passive: false });
  svg.addEventListener("pointerdown", (event) => {
    // 只允许从画布空白处开始拖动。过去在节点上也调用 pointer capture，
    // 某些浏览器会把随后合成的 click 重定向到 SVG，导致节点点击看起来无效。
    if (event.target !== svg) return;
    dragging = true;
    start = { x: event.clientX - panX, y: event.clientY - panY };
    svg.setPointerCapture?.(event.pointerId);
  });
  svg.addEventListener("pointermove", (event) => { if (!dragging) return; panX = event.clientX - start.x; panY = event.clientY - start.y; transform(); });
  svg.addEventListener("pointerup", () => { dragging = false; });
  svg.addEventListener("pointercancel", () => { dragging = false; });
  svg.addEventListener("click", (event) => {
    if (event.target === svg) {
      selectedEdge = null;
      if (selected) selected.setAttribute("stroke", "#d4dcea");
      selected = null;
      visibleEdgePaths().forEach((path) => { path.setAttribute("stroke", "#b9c2d2"); path.setAttribute("stroke-width", "1.25"); path.setAttribute("opacity", "1"); });
    }
  });
  container.append(svg);
  return { zoomIn: () => zoom(1.18), zoomOut: () => zoom(0.84), reset, nodeCount: nodes.length, edgeCount: edges.length };
}

export function graphLegend(includeDynamic = true) {
  const entries = [["Service", "服务"], ["Database", "数据库/缓存"], ["Cluster", "集群"], ["Instance", "实例"]];
  if (includeDynamic) entries.push(["Incident", "故障"], ["RCAHypothesis", "根因假设"]);
  return entries.map(([kind, label]) => `<span><i class="legend-dot" style="background:${palette[kind]}"></i>${label}</span>`).join("");
}
