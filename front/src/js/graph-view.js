import {
  drag,
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  select,
  zoom,
  zoomIdentity,
} from "d3";
import { buildIncidentSemantics } from "./graph-semantics.js";

const NODE_RADIUS = 32;
const MIN_SCALE = 0.18;
const MAX_SCALE = 2.4;

let graphSequence = 0;

const palette = {
  UIControl: "#c44578",
  UIFunction: "#c06b2b",
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
  VM: "#a96332",
  NetworkSwitch: "#258b82",
  Incident: "#c43d4d",
  RCAHypothesis: "#95509a",
  LogEvent: "#ba596d",
  Exception: "#a93040",
  Trace: "#765795",
};

const swimlanes = [
  {
    id: "ui",
    label: "UI 交互与页面功能",
    description: "页面、控件与用户入口",
    color: "#c44578",
    kinds: new Set(["UIControl", "UIFunction"]),
  },
  {
    id: "service",
    label: "接口网关与业务服务",
    description: "API、网关和业务处理模块",
    color: "#3f6fba",
    kinds: new Set(["API", "Service", "System", "Component", "Function"]),
  },
  {
    id: "data",
    label: "数据存储与中间件",
    description: "数据库、缓存、消息与逻辑集群",
    color: "#178a80",
    kinds: new Set(["Database", "Cache", "Queue", "Middleware", "Cluster"]),
  },
  {
    id: "runtime",
    label: "容器实例与宿主机",
    description: "实例、容器、虚机、主机与网络",
    color: "#c8722f",
    kinds: new Set(["Instance", "Host", "Pod", "VM", "NetworkSwitch"]),
  },
];

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

// Retained for compatibility with existing layout tests and callers.
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

function appendMarker(defs, id, color) {
  defs.append("marker")
    .attr("id", id)
    .attr("viewBox", "0 0 10 10")
    .attr("refX", 9)
    .attr("refY", 5)
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("orient", "auto")
    .attr("markerUnits", "strokeWidth")
    .append("path")
    .attr("d", "M 0 0 L 10 5 L 0 10 z")
    .attr("fill", color);
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

function edgeGeometry(source, target, curvature = 0) {
  if (source.x === target.x && source.y === target.y) {
    const loopRadius = NODE_RADIUS + 22;
    return {
      d: `M ${source.x} ${source.y - NODE_RADIUS} C ${source.x + loopRadius} ${source.y - loopRadius * 2}, ${source.x - loopRadius} ${source.y - loopRadius * 2}, ${source.x} ${source.y - NODE_RADIUS}`,
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
  const sourceOffset = NODE_RADIUS;
  const targetOffset = NODE_RADIUS + 4;
  const startX = source.x + unitX * sourceOffset;
  const startY = source.y + unitY * sourceOffset;
  const endX = target.x - unitX * targetOffset;
  const endY = target.y - unitY * targetOffset;
  const controlX = (startX + endX) / 2 + perpendicularX * curvature;
  const controlY = (startY + endY) / 2 + perpendicularY * curvature;
  return {
    d: `M ${startX} ${startY} Q ${controlX} ${controlY} ${endX} ${endY}`,
    labelX: (startX + 2 * controlX + endX) / 4,
    labelY: (startY + 2 * controlY + endY) / 4 - 7,
  };
}

function hash(value) {
  let result = 2166136261;
  for (const character of String(value || "")) {
    result ^= character.codePointAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function initialPosition(node, index, count, width, height, primaryIndexes) {
  if (primaryIndexes.has(node.name)) {
    const chainIndex = primaryIndexes.get(node.name);
    const chainSize = primaryIndexes.size;
    return {
      x: chainSize === 1 ? width / 2 : 110 + chainIndex * ((width - 220) / (chainSize - 1)),
      y: height / 2,
    };
  }
  const seed = hash(`${node.name}:${index}`);
  const angle = ((seed % 3600) / 3600) * Math.PI * 2;
  const ring = 0.2 + ((seed >>> 12) % 1000) / 2500;
  const radius = Math.min(width, height) * ring;
  const spread = Math.min(1, Math.sqrt(Math.max(1, count) / 18));
  return {
    x: width / 2 + Math.cos(angle) * radius * spread,
    y: height / 2 + Math.sin(angle) * radius * spread * 0.78,
  };
}

function laneForNode(node) {
  const direct = swimlanes.find((lane) => lane.kinds.has(String(node.kind || "")));
  if (direct) return direct;
  const text = `${node.kind || ""} ${node.layer || ""} ${node.name || ""}`.toLocaleLowerCase();
  if (/ui|页面|界面|前端|交互|控件/.test(text)) return swimlanes[0];
  if (/数据库|数据|存储|缓存|消息|队列|中间件|database|cache|queue|cluster/.test(text)) return swimlanes[2];
  if (/实例|容器|宿主|主机|虚机|网络|instance|pod|host|vm/.test(text)) return swimlanes[3];
  return swimlanes[1];
}

export function createSwimlanePlan(nodes, minimumWidth = 960) {
  const groups = new Map(swimlanes.map((lane) => [lane.id, []]));
  nodes.forEach((node) => groups.get(laneForNode(node).id).push(node));
  const outerPadding = 34;
  const laneGap = 18;
  const canvasWidth = Math.max(minimumWidth, outerPadding * 2 + laneGap * 3 + 220 * swimlanes.length);
  const laneWidth = (canvasWidth - outerPadding * 2 - laneGap * 3) / swimlanes.length;
  const laneSpecs = swimlanes.map((lane) => {
    const laneNodes = groups.get(lane.id).sort((left, right) => (
      String(left.kind || "").localeCompare(String(right.kind || ""), "zh-CN")
      || String(left.name).localeCompare(String(right.name), "zh-CN")
    ));
    const columns = laneNodes.length > 5 && laneWidth >= 220 ? 2 : 1;
    return { ...lane, nodes: laneNodes, columns, rows: Math.max(1, Math.ceil(laneNodes.length / columns)) };
  });
  const laneHeight = Math.max(520, 142 + Math.max(...laneSpecs.map((lane) => lane.rows)) * 112);
  const guides = [];
  const positions = new Map();
  let cursorX = outerPadding;
  laneSpecs.forEach((lane) => {
    guides.push({ ...lane, x: cursorX, y: 32, width: laneWidth, height: laneHeight });
    lane.nodes.forEach((node, index) => {
      const column = index % lane.columns;
      const row = Math.floor(index / lane.columns);
      const targetX = cursorX + laneWidth * ((column + 0.5) / lane.columns);
      const targetY = 148 + row * 112;
      positions.set(node.name, {
        x: targetX,
        y: targetY,
        laneTargetX: targetX,
        laneTargetY: targetY,
        laneId: lane.id,
        laneColor: lane.color,
      });
    });
    cursorX += laneWidth + laneGap;
  });
  return { positions, guides, width: canvasWidth, height: laneHeight + 64 };
}

function appendTextLines(group, lines) {
  const title = group.append("text").attr("class", "graph-node-title").attr("x", 0);
  const firstY = lines.length === 1 ? 4 : -2;
  lines.forEach((line, index) => {
    title.append("tspan").attr("x", 0).attr("y", firstY + index * 12).text(line);
  });
}

function appendBadge(group, label, className, y, width) {
  const badge = group.append("g")
    .attr("class", `graph-node-badge ${className}`)
    .attr("transform", `translate(${-width / 2} ${y})`);
  badge.append("rect").attr("width", width).attr("height", 18).attr("rx", 4);
  badge.append("text").attr("x", width / 2).attr("y", 12).text(label);
}

export function renderGraph(
  container,
  graph,
  {
    mode = "architecture",
    layoutMode = "force",
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
  const activeLayout = mode === "architecture" && layoutMode === "swimlane" ? "swimlane" : "force";
  const isSwimlane = activeLayout === "swimlane";
  const viewportWidth = Math.max(720, container.clientWidth || 960);
  const viewportHeight = mode === "incident" ? 640 : 720;
  const density = Math.max(1, Math.sqrt(nodes.length / (mode === "incident" ? 14 : 18)));
  const swimlanePlan = isSwimlane ? createSwimlanePlan(nodes, viewportWidth) : null;
  const width = swimlanePlan?.width || Math.min(3200, Math.max(viewportWidth, viewportWidth * density));
  const height = swimlanePlan?.height || Math.min(2400, Math.max(viewportHeight, viewportHeight * density * 0.82));
  const semantics = mode === "incident"
    ? buildIncidentSemantics(hypotheses, llmDecision, nodeNames)
    : { primary: null, alternatives: [], overlays: [], candidateRanks: {}, start: "", end: "", warnings: [] };
  const routes = routeMap(edges);
  const showEdgeLabels = isSwimlane ? edges.length <= 18 : shouldShowEdgeLabels(nodes.length, edges.length);
  const visiblePrimaryChain = (semantics.primary?.chain || []).filter((name) => nodeNames.has(name));
  const primaryIndexes = new Map(visiblePrimaryChain.map((name, index) => [name, index]));

  const simulationNodes = nodes.map((node, index) => {
    const position = swimlanePlan?.positions.get(node.name)
      || initialPosition(node, index, nodes.length, width, height, primaryIndexes);
    return { ...node, __data: node, ...position, initialX: position.x, initialY: position.y };
  });
  const nodeByName = new Map(simulationNodes.map((node) => [node.name, node]));
  const laneById = new Map((swimlanePlan?.guides || []).map((lane) => [lane.id, lane]));
  const constrainToLane = (node, nextX, nextY) => {
    const lane = laneById.get(node.laneId);
    if (!lane) return { x: nextX, y: nextY };
    const horizontalPadding = NODE_RADIUS + 14;
    const topPadding = 66 + NODE_RADIUS + 18;
    const bottomPadding = NODE_RADIUS + 28;
    return {
      x: clamp(nextX, lane.x + horizontalPadding, lane.x + lane.width - horizontalPadding),
      y: clamp(nextY, lane.y + topPadding, lane.y + lane.height - bottomPadding),
    };
  };
  const simulationLinks = edges.map((edge, index) => ({
    source: nodeByName.get(edge.source),
    target: nodeByName.get(edge.target),
    data: edge,
    curvature: routes.get(edge) || 0,
    index,
  }));

  const svg = select(container)
    .append("svg")
    .attr("class", `graph-svg graph-layout-${activeLayout}`)
    .attr("role", "img")
    .attr("aria-label", mode === "incident" ? "故障传播知识图谱" : "系统架构知识图谱")
    .attr("viewBox", `0 0 ${viewportWidth} ${viewportHeight}`)
    .attr("tabindex", 0);
  const defs = svg.append("defs");
  const markerIds = {
    base: `graph-arrow-base-${sequence}`,
    alternative: `graph-arrow-alternative-${sequence}`,
    model: `graph-arrow-model-${sequence}`,
    algorithm: `graph-arrow-algorithm-${sequence}`,
  };
  appendMarker(defs, markerIds.base, "#8795aa");
  appendMarker(defs, markerIds.alternative, "#98a4b5");
  appendMarker(defs, markerIds.model, "#cf3545");
  appendMarker(defs, markerIds.algorithm, "#c47a20");

  const viewport = svg.append("g").attr("class", "graph-viewport");
  const guideLayer = viewport.append("g").attr("class", "graph-layer graph-layout-guides");
  const baseEdgeLayer = viewport.append("g").attr("class", "graph-layer graph-layer-edges");
  const alternativeLayer = viewport.append("g").attr("class", "graph-layer graph-layer-alternatives");
  const primaryUnderlayLayer = viewport.append("g").attr("class", "graph-layer graph-layer-primary-underlay");
  const primaryLayer = viewport.append("g").attr("class", "graph-layer graph-layer-primary");
  const nodeLayer = viewport.append("g").attr("class", "graph-layer graph-layer-nodes");

  if (isSwimlane) {
    const guides = guideLayer.selectAll("g.graph-swimlane")
      .data(swimlanePlan.guides)
      .join("g")
      .attr("class", (lane) => `graph-swimlane graph-swimlane-${lane.id}`)
      .style("--lane-color", (lane) => lane.color);
    guides.append("rect")
      .attr("class", "graph-swimlane-panel")
      .attr("x", (lane) => lane.x)
      .attr("y", (lane) => lane.y)
      .attr("width", (lane) => lane.width)
      .attr("height", (lane) => lane.height)
      .attr("rx", 12);
    guides.append("rect")
      .attr("class", "graph-swimlane-header")
      .attr("x", (lane) => lane.x)
      .attr("y", (lane) => lane.y)
      .attr("width", (lane) => lane.width)
      .attr("height", 66)
      .attr("rx", 12);
    guides.append("rect")
      .attr("class", "graph-swimlane-accent")
      .attr("x", (lane) => lane.x)
      .attr("y", (lane) => lane.y)
      .attr("width", 5)
      .attr("height", 66)
      .attr("rx", 3);
    guides.append("text")
      .attr("class", "graph-swimlane-title")
      .attr("x", (lane) => lane.x + 17)
      .attr("y", (lane) => lane.y + 27)
      .text((lane) => lane.label);
    guides.append("text")
      .attr("class", "graph-swimlane-description")
      .attr("x", (lane) => lane.x + 17)
      .attr("y", (lane) => lane.y + 47)
      .text((lane) => `${lane.description} · ${lane.nodes.length} 个节点`);
  }

  const edgeGroups = baseEdgeLayer.selectAll("g.graph-edge-record")
    .data(simulationLinks)
    .join("g")
    .attr("class", "graph-edge-record");
  const edgePaths = edgeGroups.append("path")
    .attr("class", "graph-edge")
    .attr("fill", "none")
    .attr("marker-end", `url(#${markerIds.base})`)
    .attr("data-edge-key", (edge) => String(edge.index));
  const edgeHitPaths = edgeGroups.append("path")
    .attr("class", "graph-edge-hit")
    .attr("fill", "none")
    .attr("tabindex", 0)
    .attr("role", "button")
    .attr("aria-label", (edge) => `关系：${edge.data.source} ${edge.data.type} ${edge.data.target}`);
  const edgeLabels = edgeGroups.append("text")
    .attr("class", `graph-edge-label${showEdgeLabels ? "" : " graph-edge-label-on-demand"}`)
    .attr("text-anchor", "middle")
    .text((edge) => short(edge.data.type, 18));

  const primaryOverlayData = semantics.overlays.filter((overlay) => overlay.variant !== "alternative");
  const alternativeOverlayData = semantics.overlays.filter((overlay) => overlay.variant === "alternative");
  const overlayUnderlays = primaryUnderlayLayer.selectAll("path")
    .data(primaryOverlayData)
    .join("path")
    .attr("class", "graph-propagation-underlay")
    .attr("fill", "none");
  const primaryOverlays = primaryLayer.selectAll("path")
    .data(primaryOverlayData)
    .join("path")
    .attr("class", (overlay) => `graph-propagation-edge graph-propagation-${overlay.variant}`)
    .attr("fill", "none")
    .attr("marker-end", (overlay) => `url(#${markerIds[overlay.variant]})`);
  const alternativeOverlays = alternativeLayer.selectAll("path")
    .data(alternativeOverlayData)
    .join("path")
    .attr("class", "graph-propagation-edge graph-propagation-alternative")
    .attr("fill", "none")
    .attr("marker-end", `url(#${markerIds.alternative})`);
  const allOverlays = viewport.selectAll(".graph-propagation-edge");

  const nodeSelection = nodeLayer.selectAll("g.graph-node")
    .data(simulationNodes, (node) => node.name)
    .join("g")
    .attr("class", (node) => [
      "graph-node",
      node.name === semantics.start ? "graph-node-start" : "",
      node.name === semantics.end ? "graph-node-end" : "",
      (node.name === semantics.start || node.name === semantics.end) && semantics.primary?.source === "llm" ? "graph-node-primary-model" : "",
      (node.name === semantics.start || node.name === semantics.end) && semantics.primary?.source === "algorithm" ? "graph-node-primary-algorithm" : "",
    ].filter(Boolean).join(" "))
    .attr("tabindex", 0)
    .attr("role", "button")
    .attr("aria-label", (node) => `节点：${node.name}，类型：${node.kind || "Component"}`)
    .attr("data-node-name", (node) => node.name)
    .style("--node-color", (node) => palette[node.kind] || "#61738f")
    .style("--lane-color", (node) => node.laneColor || palette[node.kind] || "#61738f");

  nodeSelection.append("circle").attr("class", "graph-node-halo").attr("r", NODE_RADIUS + 7);
  nodeSelection.append("circle").attr("class", "graph-node-circle").attr("r", NODE_RADIUS);
  nodeSelection.each(function renderNode(node) {
    const group = select(this);
    const display = semantics.displayByNode?.[node.name] || null;
    appendTextLines(group, nodeLines(display?.label || node.name));
    group.append("text")
      .attr("class", "graph-node-kind")
      .attr("x", 0)
      .attr("y", NODE_RADIUS + 17)
      .text(display?.stage || node.kind || "Component");
    const rank = semantics.candidateRanks[node.name];
    if (rank) appendBadge(group, `Top-${rank}`, "graph-rank-badge", NODE_RADIUS + 22, 42);
    const isStart = node.name === semantics.start;
    const isEnd = node.name === semantics.end;
    if (isStart && isEnd) appendBadge(group, "起点 / 终点", "graph-endpoint-badge", -NODE_RADIUS - 29, 72);
    else if (isStart) appendBadge(group, "起点", "graph-start-badge", -NODE_RADIUS - 29, 42);
    else if (isEnd) appendBadge(group, "终点", "graph-end-badge", -NODE_RADIUS - 29, 42);
  });
  nodeSelection.append("title").text((node) => (
    `${node.name} · ${node.kind || "Component"}${node.layer ? `\n架构层：${node.layer}` : ""}${node.description ? `\n${node.description}` : ""}`
  ));

  let simulation = forceSimulation(simulationNodes);
  if (isSwimlane) {
    simulation
      .force("link", forceLink(simulationLinks)
        .id((node) => node.name)
        .distance(138)
        .strength(0.08))
      .force("charge", forceManyBody().strength(Math.max(-210, -72 - nodes.length * 1.4)))
      .force("collision", forceCollide(NODE_RADIUS + 24).strength(1).iterations(3))
      .force("x", forceX((node) => node.laneTargetX).strength(0.38))
      .force("y", forceY((node) => node.laneTargetY).strength(0.32))
      .velocityDecay(0.42)
      .alphaDecay(0.042);
  } else {
    simulation
      .force("link", forceLink(simulationLinks)
        .id((node) => node.name)
        .distance(mode === "incident" ? 182 : 172)
        .strength(mode === "incident" ? 0.52 : 0.34))
      .force("charge", forceManyBody().strength(Math.max(-720, -250 - nodes.length * 3.2)))
      .force("collision", forceCollide(NODE_RADIUS + (mode === "incident" ? 34 : 30)).strength(0.95).iterations(2))
      .force("center", forceCenter(width / 2, height / 2))
      .force("x", forceX((node) => {
        if (mode !== "incident" || !primaryIndexes.has(node.name)) return width / 2;
        const index = primaryIndexes.get(node.name);
        return primaryIndexes.size === 1 ? width / 2 : 110 + index * ((width - 220) / (primaryIndexes.size - 1));
      }).strength((node) => (mode === "incident" && primaryIndexes.has(node.name) ? 0.32 : 0.018)))
      .force("y", forceY(height / 2).strength((node) => (
        mode === "incident" && primaryIndexes.has(node.name) ? 0.22 : 0.024
      )))
      .velocityDecay(0.34)
      .alphaDecay(0.035);
  }

  const updatePositions = () => {
    simulationNodes.forEach((node) => {
      node.x = Number.isFinite(node.x) ? node.x : width / 2;
      node.y = Number.isFinite(node.y) ? node.y : height / 2;
      if (isSwimlane) Object.assign(node, constrainToLane(node, node.x, node.y));
    });
    nodeSelection.attr("transform", (node) => `translate(${node.x} ${node.y})`);
    edgeGroups.each(function updateEdge(link) {
      const geometry = edgeGeometry(link.source, link.target, link.curvature);
      const group = select(this);
      group.select(".graph-edge").attr("d", geometry.d);
      group.select(".graph-edge-hit").attr("d", geometry.d);
      group.select(".graph-edge-label").attr("x", geometry.labelX).attr("y", geometry.labelY);
    });
    const overlayPath = (overlay) => {
      const source = nodeByName.get(overlay.source);
      const target = nodeByName.get(overlay.target);
      return source && target ? edgeGeometry(source, target).d : "";
    };
    overlayUnderlays.attr("d", overlayPath);
    primaryOverlays.attr("d", overlayPath);
    alternativeOverlays.attr("d", overlayPath);
  };

  const clearFocus = () => {
    nodeSelection.classed("graph-selected graph-related graph-muted graph-search-hit", false);
    edgePaths.classed("graph-selected graph-related graph-muted", false);
    edgeLabels.classed("graph-selected graph-related graph-muted", false);
    allOverlays.classed("graph-related graph-muted", false);
    overlayUnderlays.classed("graph-related graph-muted", false);
  };

  const chooseNode = (node) => {
    const name = node.name;
    const relatedNames = new Set([name]);
    const relatedEdges = edges.filter((edge) => {
      const related = edge.source === name || edge.target === name;
      if (related) relatedNames.add(edge.source === name ? edge.target : edge.source);
      return related;
    });
    semantics.overlays.forEach((edge) => {
      if (edge.source === name || edge.target === name) relatedNames.add(edge.source === name ? edge.target : edge.source);
    });
    nodeSelection
      .classed("graph-selected", (item) => item.name === name)
      .classed("graph-related", (item) => item.name !== name && relatedNames.has(item.name))
      .classed("graph-muted", (item) => !relatedNames.has(item.name));
    edgePaths
      .classed("graph-related", (link) => link.data.source === name || link.data.target === name)
      .classed("graph-muted", (link) => link.data.source !== name && link.data.target !== name);
    edgeLabels
      .classed("graph-related", (link) => link.data.source === name || link.data.target === name)
      .classed("graph-muted", (link) => link.data.source !== name && link.data.target !== name);
    allOverlays
      .classed("graph-related", (edge) => edge.source === name || edge.target === name)
      .classed("graph-muted", (edge) => edge.source !== name && edge.target !== name);
    overlayUnderlays
      .classed("graph-related", (edge) => edge.source === name || edge.target === name)
      .classed("graph-muted", (edge) => edge.source !== name && edge.target !== name);
    onSelect(node.__data, relatedEdges);
  };

  const chooseEdge = (selectedLink) => {
    nodeSelection
      .classed("graph-related", (node) => node.name === selectedLink.data.source || node.name === selectedLink.data.target)
      .classed("graph-muted", (node) => node.name !== selectedLink.data.source && node.name !== selectedLink.data.target)
      .classed("graph-selected", false);
    edgePaths
      .classed("graph-selected", (link) => link.index === selectedLink.index)
      .classed("graph-muted", (link) => link.index !== selectedLink.index);
    edgeLabels
      .classed("graph-selected", (link) => link.index === selectedLink.index)
      .classed("graph-muted", (link) => link.index !== selectedLink.index);
    allOverlays.classed("graph-muted", true);
    overlayUnderlays.classed("graph-muted", true);
    onSelectEdge(selectedLink.data);
  };

  edgeHitPaths
    .on("click", (event, link) => {
      event.stopPropagation();
      chooseEdge(link);
    })
    .on("keydown", (event, link) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      chooseEdge(link);
    });
  nodeSelection
    .on("click", (event, node) => {
      if (event.defaultPrevented) return;
      event.stopPropagation();
      chooseNode(node);
    })
    .on("keydown", (event, node) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      chooseNode(node);
    });

  const graphBounds = () => {
    const xs = simulationNodes.map((node) => node.x);
    const ys = simulationNodes.map((node) => node.y);
    if (isSwimlane) {
      swimlanePlan.guides.forEach((lane) => {
        xs.push(lane.x, lane.x + lane.width);
        ys.push(lane.y, lane.y + lane.height);
      });
    }
    const margin = isSwimlane ? 24 : NODE_RADIUS + 42;
    return {
      minX: Math.min(...xs) - margin,
      minY: Math.min(...ys) - margin,
      maxX: Math.max(...xs) + margin,
      maxY: Math.max(...ys) + margin,
    };
  };

  const zoomBehavior = zoom()
    .scaleExtent([MIN_SCALE, MAX_SCALE])
    .filter((event) => {
      if (event.type === "wheel") return true;
      if (event.button) return false;
      return !event.target.closest?.(".graph-node");
    })
    .on("zoom", (event) => {
      viewport.attr("transform", event.transform);
      svg.classed("graph-zoomed-out", event.transform.k < 0.55);
    });
  svg.call(zoomBehavior).on("dblclick.zoom", null);
  svg.on("click.graph-clear", (event) => {
    if (event.target === svg.node()) clearFocus();
  });

  const fit = () => {
    const next = calculateFitTransform(graphBounds(), viewportWidth, viewportHeight, { padding: isSwimlane ? 28 : 64 });
    svg.call(zoomBehavior.transform, zoomIdentity.translate(next.panX, next.panY).scale(next.scale));
  };

  const nodeDrag = drag()
    .container(() => viewport.node())
    .on("start", (event, node) => {
      event.sourceEvent?.stopPropagation();
      if (!event.active) simulation.alphaTarget(0.16).restart();
      node.fx = node.x;
      node.fy = node.y;
      if (isSwimlane) {
        guideLayer.selectAll(".graph-swimlane")
          .classed("graph-swimlane-active", (lane) => lane.id === node.laneId);
      }
    })
    .on("drag", (event, node) => {
      const point = isSwimlane ? constrainToLane(node, event.x, event.y) : { x: event.x, y: event.y };
      node.x = point.x;
      node.y = point.y;
      node.fx = node.x;
      node.fy = node.y;
      updatePositions();
    })
    .on("end", (event) => {
      if (!event.active) simulation.alphaTarget(0);
      if (isSwimlane) guideLayer.selectAll(".graph-swimlane").classed("graph-swimlane-active", false);
    });
  nodeSelection.call(nodeDrag);

  let fitWhenSettled = true;
  simulation.on("tick", updatePositions).on("end", () => {
    if (!fitWhenSettled) return;
    fitWhenSettled = false;
    fit();
  });
  updatePositions();
  fit();

  let searchPulseTimer = 0;
  const focusNode = (name) => {
    const node = nodeByName.get(name);
    if (!node) return false;
    chooseNode(node);
    const scale = isSwimlane ? 1 : 1.12;
    svg.call(
      zoomBehavior.transform,
      zoomIdentity.translate(viewportWidth / 2 - node.x * scale, viewportHeight / 2 - node.y * scale).scale(scale),
    );
    nodeSelection.filter((item) => item.name === name).classed("graph-search-hit", false);
    void nodeSelection.filter((item) => item.name === name).node()?.getBoundingClientRect();
    nodeSelection.filter((item) => item.name === name).classed("graph-search-hit", true);
    if (searchPulseTimer) window.clearTimeout(searchPulseTimer);
    searchPulseTimer = window.setTimeout(() => {
      nodeSelection.filter((item) => item.name === name).classed("graph-search-hit", false);
      searchPulseTimer = 0;
    }, 1800);
    return true;
  };

  const zoomBy = (factor) => svg.call(zoomBehavior.scaleBy, factor, [viewportWidth / 2, viewportHeight / 2]);
  return {
    zoomIn: () => zoomBy(1.18),
    zoomOut: () => zoomBy(0.84),
    fit,
    reset: fit,
    focusNode,
    clearFocus,
    relayout() {
      simulationNodes.forEach((node, index) => {
        const position = isSwimlane
          ? swimlanePlan.positions.get(node.name)
          : initialPosition(node, index, simulationNodes.length, width, height, primaryIndexes);
        node.x = position.x;
        node.y = position.y;
        node.initialX = position.x;
        node.initialY = position.y;
        node.vx = 0;
        node.vy = 0;
        node.fx = null;
        node.fy = null;
      });
      updatePositions();
      fitWhenSettled = true;
      simulation.alpha(1).restart();
    },
    destroy() {
      simulation.stop();
      if (searchPulseTimer) window.clearTimeout(searchPulseTimer);
      nodeSelection.on(".drag", null).on("click", null).on("keydown", null);
      edgeHitPaths.on("click", null).on("keydown", null);
      svg.on(".zoom", null).on(".graph-clear", null);
    },
    nodeCount: nodes.length,
    edgeCount: edges.length,
    semantics,
    layoutMode: activeLayout,
  };
}

export function graphLegend(includeDynamic = true, includePropagation = false) {
  const entries = [
    ["UIControl", "界面交互"],
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
