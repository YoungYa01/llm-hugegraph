import { createForceLayout } from "./graph-layout.js";
import { buildIncidentSemantics } from "./graph-semantics.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_RADIUS = 32;
const MIN_SCALE = 0.35;
const MAX_SCALE = 2.4;

let graphSequence = 0;

const palette = {
  Service: "#3f6fba",
  API: "#5179bd",
  Component: "#61769b",
  Function: "#6d7f9d",
  System: "#334b72",
  Database: "#178a80",
  Cache: "#179b91",
  Queue: "#7460ad",
  Middleware: "#6874a7",
  Cluster: "#117b74",
  Instance: "#c8722f",
  Host: "#b8662b",
  Pod: "#ca7044",
  Incident: "#c43d4d",
  RCAHypothesis: "#95509a",
  LogEvent: "#ba596d",
  Exception: "#a93040",
  Trace: "#765795",
};

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  return element;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function short(value, length = 20) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length - 1)}...` : text;
}

function nodeLines(value) {
  const text = String(value || "未命名节点");
  if (text.length <= 11) return [text];
  if (text.length <= 20) {
    const splitAt = Math.ceil(text.length / 2);
    return [text.slice(0, splitAt), text.slice(splitAt)];
  }
  return [text.slice(0, 10), `${text.slice(10, 19)}...`];
}

export function calculateFitTransform(bounds, viewportWidth, viewportHeight, options = {}) {
  const padding = Number(options.padding) || 0;
  const minScale = Number(options.minScale) || MIN_SCALE;
  const maxScale = Number(options.maxScale) || MAX_SCALE;
  const graphWidth = Math.max(1, bounds.maxX - bounds.minX);
  const graphHeight = Math.max(1, bounds.maxY - bounds.minY);
  const availableWidth = Math.max(1, viewportWidth - padding * 2);
  const availableHeight = Math.max(1, viewportHeight - padding * 2);
  const scale = clamp(Math.min(availableWidth / graphWidth, availableHeight / graphHeight), minScale, maxScale);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return {
    scale,
    panX: viewportWidth / 2 - centerX * scale,
    panY: viewportHeight / 2 - centerY * scale,
  };
}

export function createViewportState(initial = {}) {
  let scale = clamp(Number(initial.scale) || 1, MIN_SCALE, MAX_SCALE);
  let panX = Number(initial.panX) || 0;
  let panY = Number(initial.panY) || 0;
  return {
    value: () => ({ scale, panX, panY }),
    set(next) {
      scale = clamp(Number(next.scale) || 1, MIN_SCALE, MAX_SCALE);
      panX = Number(next.panX) || 0;
      panY = Number(next.panY) || 0;
    },
    panBy(deltaX, deltaY) {
      panX += Number(deltaX) || 0;
      panY += Number(deltaY) || 0;
    },
    zoomAt(nextScale, screenX, screenY) {
      const targetScale = clamp(Number(nextScale) || scale, MIN_SCALE, MAX_SCALE);
      const worldX = (screenX - panX) / scale;
      const worldY = (screenY - panY) / scale;
      scale = targetScale;
      panX = screenX - worldX * scale;
      panY = screenY - worldY * scale;
    },
    toWorld(screenX, screenY) {
      return { x: (screenX - panX) / scale, y: (screenY - panY) / scale };
    },
  };
}

export function shouldShowEdgeLabels(nodeCount, edgeCount) {
  return edgeCount <= 12 && edgeCount <= Math.max(6, nodeCount * 0.8);
}

function marker(defs, id, color) {
  const element = svgElement("marker", {
    id,
    viewBox: "0 0 10 10",
    refX: "9",
    refY: "5",
    markerWidth: "6",
    markerHeight: "6",
    orient: "auto",
    markerUnits: "strokeWidth",
  });
  element.append(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: color }));
  defs.append(element);
}

function routeMap(edges) {
  const groups = new Map();
  edges.forEach((edge) => {
    const ends = [edge.source, edge.target].sort();
    const key = `${ends[0]}\u0000${ends[1]}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
  });
  const routes = new Map();
  groups.forEach((items) => {
    items.forEach((edge, index) => {
      routes.set(edge, items.length === 1 ? 0 : (index - (items.length - 1) / 2) * 28);
    });
  });
  return routes;
}

function edgeGeometry(source, target, curvature = 0, radius = NODE_RADIUS) {
  if (source.x === target.x && source.y === target.y) {
    const loopRadius = radius + 22;
    return {
      d: `M ${source.x} ${source.y - radius} C ${source.x + loopRadius} ${source.y - loopRadius * 2}, ${source.x - loopRadius} ${source.y - loopRadius * 2}, ${source.x} ${source.y - radius}`,
      labelX: source.x,
      labelY: source.y - loopRadius * 1.7,
    };
  }
  const deltaX = target.x - source.x;
  const deltaY = target.y - source.y;
  const distance = Math.max(1, Math.hypot(deltaX, deltaY));
  const unitX = deltaX / distance;
  const unitY = deltaY / distance;
  const perpendicularX = -unitY;
  const perpendicularY = unitX;
  const startX = source.x + unitX * radius;
  const startY = source.y + unitY * radius;
  const endX = target.x - unitX * (radius + 4);
  const endY = target.y - unitY * (radius + 4);
  const controlX = (startX + endX) / 2 + perpendicularX * curvature;
  const controlY = (startY + endY) / 2 + perpendicularY * curvature;
  const labelX = (startX + 2 * controlX + endX) / 4;
  const labelY = (startY + 2 * controlY + endY) / 4 - 7;
  return {
    d: `M ${startX} ${startY} Q ${controlX} ${controlY} ${endX} ${endY}`,
    labelX,
    labelY,
  };
}

export function calculateClientPoint(rect, width, height, clientX, clientY) {
  const scale = Math.min(
    Math.max(1, Number(rect.width)) / Math.max(1, width),
    Math.max(1, Number(rect.height)) / Math.max(1, height),
  );
  const offsetX = (Number(rect.width) - width * scale) / 2;
  const offsetY = (Number(rect.height) - height * scale) / 2;
  return {
    x: (clientX - Number(rect.left) - offsetX) / scale,
    y: (clientY - Number(rect.top) - offsetY) / scale,
  };
}

function clientPoint(svg, event, width, height) {
  return calculateClientPoint(svg.getBoundingClientRect(), width, height, event.clientX, event.clientY);
}

function appendTextLines(group, lines) {
  const title = svgElement("text", { class: "graph-node-title", x: "0" });
  const firstY = lines.length === 1 ? 4 : -2;
  lines.forEach((line, index) => {
    const span = svgElement("tspan", { x: "0", y: firstY + index * 12 });
    span.textContent = line;
    title.append(span);
  });
  group.append(title);
}

function appendBadge(group, label, className, y, width) {
  const badge = svgElement("g", { class: `graph-node-badge ${className}`, transform: `translate(${-width / 2} ${y})` });
  badge.append(svgElement("rect", { width, height: "18", rx: "4" }));
  const text = svgElement("text", { x: width / 2, y: "12" });
  text.textContent = label;
  badge.append(text);
  group.append(badge);
}

export function renderGraph(
  container,
  graph,
  {
    mode = "architecture",
    hypotheses = [],
    llmDecision = {},
    onSelect = () => {},
    onSelectEdge = () => {},
  } = {},
) {
  container.replaceChildren();
  const nodes = (graph.nodes || []).slice(0, 500);
  const nodeNames = new Set(nodes.map((node) => node.name));
  const edges = (graph.edges || [])
    .filter((edge) => nodeNames.has(edge.source) && nodeNames.has(edge.target))
    .slice(0, 1200);
  if (!nodes.length) return null;

  const sequence = ++graphSequence;
  const width = Math.max(720, container.clientWidth || 960);
  const height = mode === "incident" ? 640 : 720;
  const semantics = mode === "incident"
    ? buildIncidentSemantics(hypotheses, llmDecision, nodeNames)
    : { primary: null, alternatives: [], overlays: [], candidateRanks: {}, start: "", end: "", warnings: [] };
  const layout = createForceLayout(nodes, edges, {
    mode,
    primaryChain: semantics.primary?.chain || [],
    width,
    height,
    nodeRadius: NODE_RADIUS,
  });
  const viewportState = createViewportState();
  const routes = routeMap(edges);
  const showEdgeLabels = shouldShowEdgeLabels(nodes.length, edges.length);

  const svg = svgElement("svg", {
    class: "graph-svg",
    role: "img",
    "aria-label": mode === "incident" ? "故障传播知识图谱" : "系统架构知识图谱",
    viewBox: `0 0 ${width} ${height}`,
    tabindex: "0",
  });
  const defs = svgElement("defs");
  const markerIds = {
    base: `graph-arrow-base-${sequence}`,
    alternative: `graph-arrow-alternative-${sequence}`,
    model: `graph-arrow-model-${sequence}`,
    algorithm: `graph-arrow-algorithm-${sequence}`,
  };
  marker(defs, markerIds.base, "#9aa6b8");
  marker(defs, markerIds.alternative, "#98a4b5");
  marker(defs, markerIds.model, "#cf3545");
  marker(defs, markerIds.algorithm, "#c47a20");
  svg.append(defs);

  const viewport = svgElement("g", { class: "graph-viewport" });
  const baseEdgeLayer = svgElement("g", { class: "graph-layer graph-layer-edges" });
  const alternativeLayer = svgElement("g", { class: "graph-layer graph-layer-alternatives" });
  const primaryUnderlayLayer = svgElement("g", { class: "graph-layer graph-layer-primary-underlay" });
  const primaryLayer = svgElement("g", { class: "graph-layer graph-layer-primary" });
  const nodeLayer = svgElement("g", { class: "graph-layer graph-layer-nodes" });
  viewport.append(baseEdgeLayer, alternativeLayer, primaryUnderlayLayer, primaryLayer, nodeLayer);
  svg.append(viewport);

  const edgeRecords = [];
  edges.forEach((edge, index) => {
    const path = svgElement("path", {
      class: "graph-edge",
      fill: "none",
      "marker-end": `url(#${markerIds.base})`,
      "data-edge-key": String(index),
    });
    const hitPath = svgElement("path", {
      class: "graph-edge-hit",
      fill: "none",
      tabindex: "0",
      role: "button",
      "aria-label": `关系：${edge.source} ${edge.type} ${edge.target}`,
    });
    const label = svgElement("text", {
      class: `graph-edge-label${showEdgeLabels ? "" : " graph-edge-label-on-demand"}`,
      "text-anchor": "middle",
    });
    label.textContent = short(edge.type, 18);
    baseEdgeLayer.append(path, hitPath, label);
    edgeRecords.push({ edge, path, hitPath, label, curvature: routes.get(edge) || 0, index });
  });

  const overlayRecords = [];
  semantics.overlays.forEach((overlay) => {
    const layer = overlay.variant === "alternative" ? alternativeLayer : primaryLayer;
    if (overlay.variant !== "alternative") {
      const underlay = svgElement("path", { class: "graph-propagation-underlay", fill: "none" });
      primaryUnderlayLayer.append(underlay);
      overlayRecords.push({ overlay, path: underlay, underlay: true });
    }
    const path = svgElement("path", {
      class: `graph-propagation-edge graph-propagation-${overlay.variant}`,
      fill: "none",
      "marker-end": `url(#${markerIds[overlay.variant]})`,
    });
    layer.append(path);
    overlayRecords.push({ overlay, path, underlay: false });
  });

  const nodeRecords = new Map();
  nodes.forEach((node) => {
    const isStart = node.name === semantics.start;
    const isEnd = node.name === semantics.end;
    const semanticClasses = [
      isStart ? "graph-node-start" : "",
      isEnd ? "graph-node-end" : "",
      (isStart || isEnd) && semantics.primary?.source === "llm" ? "graph-node-primary-model" : "",
      (isStart || isEnd) && semantics.primary?.source === "algorithm" ? "graph-node-primary-algorithm" : "",
    ].filter(Boolean).join(" ");
    const group = svgElement("g", {
      class: `graph-node${semanticClasses ? ` ${semanticClasses}` : ""}`,
      tabindex: "0",
      role: "button",
      "aria-label": `节点：${node.name}，类型：${node.kind || "Component"}`,
      "data-node-name": node.name,
    });
    group.style.setProperty("--node-color", palette[node.kind] || "#61738f");
    group.append(svgElement("circle", { class: "graph-node-halo", r: NODE_RADIUS + 7 }));
    group.append(svgElement("circle", { class: "graph-node-circle", r: NODE_RADIUS }));
    appendTextLines(group, nodeLines(node.name));
    const kind = svgElement("text", { class: "graph-node-kind", x: "0", y: NODE_RADIUS + 17 });
    kind.textContent = node.kind || "Component";
    group.append(kind);

    const rank = semantics.candidateRanks[node.name];
    if (rank) appendBadge(group, `Top-${rank}`, "graph-rank-badge", NODE_RADIUS + 22, 42);
    if (isStart && isEnd) appendBadge(group, "起点 / 终点", "graph-endpoint-badge", -NODE_RADIUS - 29, 72);
    else if (isStart) appendBadge(group, "起点", "graph-start-badge", -NODE_RADIUS - 29, 42);
    else if (isEnd) appendBadge(group, "终点", "graph-end-badge", -NODE_RADIUS - 29, 42);

    const browserTitle = svgElement("title");
    browserTitle.textContent = `${node.name} · ${node.kind || "Component"}${node.description ? `\n${node.description}` : ""}`;
    group.append(browserTitle);
    nodeLayer.append(group);
    nodeRecords.set(node.name, { node, group });
  });

  const applyViewport = () => {
    const { scale, panX, panY } = viewportState.value();
    viewport.setAttribute("transform", `translate(${panX} ${panY}) scale(${scale})`);
    svg.classList.toggle("graph-zoomed-out", scale < 0.55);
  };

  const updatePositions = () => {
    nodeRecords.forEach(({ group }, name) => {
      const position = layout.position(name);
      if (position) group.setAttribute("transform", `translate(${position.x} ${position.y})`);
    });
    edgeRecords.forEach((record) => {
      const source = layout.position(record.edge.source);
      const target = layout.position(record.edge.target);
      if (!source || !target) return;
      const geometry = edgeGeometry(source, target, record.curvature);
      record.path.setAttribute("d", geometry.d);
      record.hitPath.setAttribute("d", geometry.d);
      record.label.setAttribute("x", geometry.labelX);
      record.label.setAttribute("y", geometry.labelY);
    });
    overlayRecords.forEach((record) => {
      const source = layout.position(record.overlay.source);
      const target = layout.position(record.overlay.target);
      if (!source || !target) return;
      record.path.setAttribute("d", edgeGeometry(source, target, 0, NODE_RADIUS + 2).d);
    });
  };

  const clearFocus = () => {
    nodeRecords.forEach(({ group }) => group.classList.remove("graph-selected", "graph-related", "graph-muted"));
    edgeRecords.forEach(({ path, label }) => {
      path.classList.remove("graph-selected", "graph-related", "graph-muted");
      label.classList.remove("graph-selected", "graph-related", "graph-muted");
    });
    overlayRecords.forEach(({ path }) => path.classList.remove("graph-related", "graph-muted"));
  };

  const chooseNode = (name) => {
    const record = nodeRecords.get(name);
    if (!record) return;
    const relatedNames = new Set([name]);
    const relatedEdges = edges.filter((edge) => {
      const related = edge.source === name || edge.target === name;
      if (related) relatedNames.add(edge.source === name ? edge.target : edge.source);
      return related;
    });
    semantics.overlays.forEach((edge) => {
      if (edge.source === name || edge.target === name) {
        relatedNames.add(edge.source === name ? edge.target : edge.source);
      }
    });
    nodeRecords.forEach(({ group }, nodeName) => {
      group.classList.toggle("graph-selected", nodeName === name);
      group.classList.toggle("graph-related", nodeName !== name && relatedNames.has(nodeName));
      group.classList.toggle("graph-muted", !relatedNames.has(nodeName));
    });
    edgeRecords.forEach(({ edge, path, label }) => {
      const related = edge.source === name || edge.target === name;
      path.classList.toggle("graph-related", related);
      path.classList.toggle("graph-muted", !related);
      label.classList.toggle("graph-related", related);
      label.classList.toggle("graph-muted", !related);
    });
    overlayRecords.forEach(({ overlay, path }) => {
      const related = overlay.source === name || overlay.target === name;
      path.classList.toggle("graph-related", related);
      path.classList.toggle("graph-muted", !related);
    });
    onSelect(record.node, relatedEdges);
  };

  const chooseEdge = (record) => {
    nodeRecords.forEach(({ group }, name) => {
      const related = name === record.edge.source || name === record.edge.target;
      group.classList.toggle("graph-related", related);
      group.classList.toggle("graph-muted", !related);
      group.classList.remove("graph-selected");
    });
    edgeRecords.forEach(({ path, label, index }) => {
      const selected = index === record.index;
      path.classList.toggle("graph-selected", selected);
      path.classList.toggle("graph-muted", !selected);
      label.classList.toggle("graph-selected", selected);
      label.classList.toggle("graph-muted", !selected);
    });
    overlayRecords.forEach(({ path }) => path.classList.add("graph-muted"));
    onSelectEdge(record.edge);
  };

  edgeRecords.forEach((record) => {
    const choose = (event) => {
      event.stopPropagation();
      chooseEdge(record);
    };
    record.hitPath.addEventListener("click", choose);
    record.hitPath.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") choose(event);
    });
  });

  let destroyed = false;
  let animationFrame = 0;
  let fitWhenSettled = true;

  const graphBounds = () => {
    const positions = layout.snapshot();
    const xs = positions.map((point) => point.x);
    const ys = positions.map((point) => point.y);
    const margin = NODE_RADIUS + 42;
    return {
      minX: Math.min(...xs) - margin,
      minY: Math.min(...ys) - margin,
      maxX: Math.max(...xs) + margin,
      maxY: Math.max(...ys) + margin,
    };
  };

  const fit = () => {
    viewportState.set(calculateFitTransform(graphBounds(), width, height, { padding: 52 }));
    applyViewport();
  };

  const schedule = () => {
    if (destroyed || animationFrame) return;
    animationFrame = requestAnimationFrame(() => {
      animationFrame = 0;
      if (destroyed || !svg.isConnected) {
        destroyed = true;
        return;
      }
      const settled = layout.step();
      updatePositions();
      if (settled) {
        if (fitWhenSettled) {
          fitWhenSettled = false;
          fit();
        }
      } else {
        schedule();
      }
    });
  };

  nodeRecords.forEach(({ group }, name) => {
    let pointer = null;
    group.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const point = clientPoint(svg, event, width, height);
      const world = viewportState.toWorld(point.x, point.y);
      const position = layout.position(name);
      pointer = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: world.x - position.x,
        offsetY: world.y - position.y,
        dragging: false,
      };
      group.setPointerCapture?.(event.pointerId);
    });
    group.addEventListener("pointermove", (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 4) {
        pointer.dragging = true;
      }
      if (!pointer.dragging) return;
      const point = clientPoint(svg, event, width, height);
      const world = viewportState.toWorld(point.x, point.y);
      layout.move(name, world.x - pointer.offsetX, world.y - pointer.offsetY);
      layout.reheat();
      updatePositions();
      schedule();
    });
    const finishPointer = (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const wasDragging = pointer.dragging;
      pointer = null;
      group.releasePointerCapture?.(event.pointerId);
      if (!wasDragging) chooseNode(name);
    };
    group.addEventListener("pointerup", finishPointer);
    group.addEventListener("pointercancel", () => { pointer = null; });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        chooseNode(name);
      }
    });
  });

  let panPointer = null;
  svg.addEventListener("pointerdown", (event) => {
    if (event.target !== svg || event.button !== 0) return;
    const point = clientPoint(svg, event, width, height);
    panPointer = { id: event.pointerId, x: point.x, y: point.y, moved: false };
    svg.setPointerCapture?.(event.pointerId);
  });
  svg.addEventListener("pointermove", (event) => {
    if (!panPointer || panPointer.id !== event.pointerId) return;
    const point = clientPoint(svg, event, width, height);
    const deltaX = point.x - panPointer.x;
    const deltaY = point.y - panPointer.y;
    if (Math.hypot(deltaX, deltaY) > 1) panPointer.moved = true;
    viewportState.panBy(deltaX, deltaY);
    panPointer.x = point.x;
    panPointer.y = point.y;
    applyViewport();
  });
  const finishPan = (event) => {
    if (!panPointer || panPointer.id !== event.pointerId) return;
    const moved = panPointer.moved;
    panPointer = null;
    svg.releasePointerCapture?.(event.pointerId);
    if (!moved) clearFocus();
  };
  svg.addEventListener("pointerup", finishPan);
  svg.addEventListener("pointercancel", () => { panPointer = null; });
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const point = clientPoint(svg, event, width, height);
    const { scale } = viewportState.value();
    viewportState.zoomAt(scale * (event.deltaY < 0 ? 1.12 : 0.88), point.x, point.y);
    applyViewport();
  }, { passive: false });

  container.append(svg);
  updatePositions();
  fit();
  schedule();

  const zoomBy = (factor) => {
    const current = viewportState.value();
    viewportState.zoomAt(current.scale * factor, width / 2, height / 2);
    applyViewport();
  };

  return {
    zoomIn: () => zoomBy(1.18),
    zoomOut: () => zoomBy(0.84),
    fit,
    reset: fit,
    relayout() {
      layout.reset();
      updatePositions();
      fitWhenSettled = true;
      schedule();
    },
    destroy() {
      destroyed = true;
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    },
    nodeCount: nodes.length,
    edgeCount: edges.length,
    semantics,
  };
}

export function graphLegend(includeDynamic = true, includePropagation = false) {
  const entries = [
    ["Service", "服务"],
    ["Database", "数据资源"],
    ["Cluster", "集群"],
    ["Instance", "实例"],
  ];
  if (includeDynamic) entries.push(["Incident", "故障"], ["RCAHypothesis", "根因候选"]);
  const nodeLegend = entries
    .map(([kind, label]) => `<span><i class="legend-dot" style="background:${palette[kind]}"></i>${label}</span>`)
    .join("");
  if (!includePropagation) return nodeLegend;
  return `${nodeLegend}<span><i class="legend-line legend-line-model"></i>模型结论</span><span><i class="legend-line legend-line-algorithm"></i>算法首选</span><span><i class="legend-line legend-line-alternative"></i>其他候选</span>`;
}
