const SVG_NS = "http://www.w3.org/2000/svg";

const palette = {
  UIControl: "#e83e8c",
  UIFunction: "#fd7e14",
  Service: "#4568dc",
  API: "#5d7ce3",
  Component: "#6679aa",
  System: "#394a78",
  Database: "#11938f",
  Cache: "#13a5a0",
  Queue: "#7a62c8",
  Middleware: "#6975bd",
  Cluster: "#16817e",
  Instance: "#e68a35",
  Host: "#d1772d",
  Pod: "#de7d45",
  VM: "#b87333",
  NetworkSwitch: "#20c997",
  Incident: "#ce4052",
  RCAHypothesis: "#a848a8",
  LogEvent: "#c85c72",
  Exception: "#b93645",
  Trace: "#8b5baa",
};

const kindIcons = {
  UIControl: "🖱️",
  UIFunction: "⚙️",
  Service: "🔌",
  API: "🌐",
  Database: "🗄️",
  Cache: "⚡",
  Queue: "📥",
  Host: "🖥️",
  Pod: "📦",
  VM: "💻",
  NetworkSwitch: "🔀",
  Incident: "🚨",
  RCAHypothesis: "🧠",
  Exception: "💥",
};

const edgeColors = {
  BELONGS_TO: "#d946ef",
  TRIGGERS: "#f97316",
  CALLS: "#3b82f6",
  PROVIDED_BY: "#0284c7",
  DEPENDS_ON: "#10b981",
  USES_DB: "#059669",
  RUNS_ON: "#f59e0b",
  HOSTED_ON: "#d97706",
  CONNECTS_TO: "#84cc16",
  AFFECTS: "#f43f5e",
  SUSPECTED_ROOT_CAUSE: "#a855f7",
};

const archColumnTitles = [
  "🖱️ UI交互与页面功能",
  "⚡ 接口网关与业务服务",
  "🗄️ 数据存储与中间件",
  "☁️ 容器实例与宿主机",
];

const fullColumnTitles = [
  "🖱️ UI交互与页面功能",
  "⚡ 接口网关与业务服务",
  "🗄️ 数据存储与中间件",
  "☁️ 容器实例与宿主机",
  "🚨 故障判定与根因假说",
];

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function groupFor(node) {
  if (["Incident", "RCAHypothesis", "LogEvent", "Exception", "Trace", "Window", "Metric"].includes(node.kind)) return 4;
  if (["Instance", "Host", "Pod", "VM", "NetworkSwitch"].includes(node.kind)) return 3;
  if (["Database", "Cache", "Queue", "Middleware", "Cluster"].includes(node.kind)) return 2;
  if (["Service", "Component", "Function", "API"].includes(node.kind)) return 1;
  if (["UIControl", "UIFunction"].includes(node.kind)) return 0;
  return 0;
}

function layout(nodes, hasDynamic) {
  const numCols = hasDynamic ? 5 : 4;
  const groups = Array.from({ length: numCols }, () => []);
  nodes.forEach((node) => {
    const idx = Math.min(groupFor(node), numCols - 1);
    groups[idx].push(node);
  });
  groups.forEach((items) => items.sort((a, b) => a.name.localeCompare(b.name, "zh-CN")));
  
  const positions = new Map();
  const laneWidths = [];
  let maxLaneRows = 1;

  const startX = 25;
  const startY = 126;
  const rowHeight = 74;
  const subColGap = 192;

  let currentLaneX = startX;

  groups.forEach((items, colIdx) => {
    const numSubCols = items.length > 5 ? 2 : 1;
    const laneWidth = items.length === 0 ? 140 : (numSubCols === 2 ? 380 : 210);
    laneWidths.push(laneWidth);

    items.forEach((node, idx) => {
      const subCol = idx % numSubCols;
      const subRow = Math.floor(idx / numSubCols);
      const posX = currentLaneX + subCol * subColGap;
      const posY = startY + subRow * rowHeight;
      positions.set(node.name, { x: posX, y: posY });
    });

    const numRows = Math.ceil(items.length / numSubCols);
    if (numRows > maxLaneRows) maxLaneRows = numRows;

    currentLaneX += laneWidth + 16;
  });

  const totalWidth = currentLaneX + 15;
  const totalHeight = Math.max(420, startY + maxLaneRows * rowHeight + 40);

  return {
    positions,
    numCols,
    width: totalWidth,
    height: totalHeight,
    laneWidths,
    startX,
    startY,
  };
}

function short(value, length = 20) {
  if (!value) return "";
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

export function renderGraph(container, graph, options = {}) {
  const onSelect = options.onSelect || options.onSelectNode || (() => {});
  const onSelectEdge = options.onSelectEdge || (() => {});

  container.innerHTML = "";

  const nodes = (graph.nodes || []).slice(0, 500);
  const nodeNames = new Set(nodes.map((node) => node.name));
  const edges = (graph.edges || []).filter(
    (edge) => nodeNames.has(edge.source) && nodeNames.has(edge.target)
  ).slice(0, 1200);

  if (!nodes.length) return null;

  const hasDynamic = nodes.some((n) =>
    ["Incident", "RCAHypothesis", "LogEvent", "Exception"].includes(n.kind)
  );
  const columnTitles = hasDynamic ? fullColumnTitles : archColumnTitles;

  const affectedNodes = new Set();
  const rootCauseNodes = new Set();

  edges.forEach((edge) => {
    if (edge.type === "AFFECTS" || edge.type === "FAULT_PROPAGATES_TO") {
      affectedNodes.add(edge.target);
      affectedNodes.add(edge.source);
    }
    if (edge.type === "SUSPECTED_ROOT_CAUSE" || edge.type === "CANDIDATE_CAUSE") {
      rootCauseNodes.add(edge.target);
    }
  });

  const { positions, width, height, laneWidths, startX, startY } = layout(nodes, hasDynamic);
  const svg = svgElement("svg", {
    role: "img",
    "aria-label": "全栈系统与故障知识图谱",
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: "xMinYMin meet",
  });

  const defs = svgElement("defs");

  const arrowNormal = svgElement("marker", {
    id: "arrow-normal",
    viewBox: "0 0 10 10",
    refX: "9",
    refY: "5",
    markerWidth: "6",
    markerHeight: "6",
    orient: "auto-start-reverse",
  });
  arrowNormal.append(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#94a3b8" }));

  const arrowAffects = svgElement("marker", {
    id: "arrow-affects",
    viewBox: "0 0 10 10",
    refX: "9",
    refY: "5",
    markerWidth: "7",
    markerHeight: "7",
    orient: "auto-start-reverse",
  });
  arrowAffects.append(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#f43f5e" }));

  const arrowRoot = svgElement("marker", {
    id: "arrow-root",
    viewBox: "0 0 10 10",
    refX: "9",
    refY: "5",
    markerWidth: "8",
    markerHeight: "8",
    orient: "auto-start-reverse",
  });
  arrowRoot.append(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#a855f7" }));

  defs.append(arrowNormal, arrowAffects, arrowRoot);
  svg.append(defs);

  const viewport = svgElement("g");
  svg.append(viewport);

  // 1. 绘制 Swimlane 泳道分栏卡片与顶部标题
  const swimlaneLayer = svgElement("g", { class: "swimlanes" });
  let currentLaneX = startX;

  columnTitles.forEach((title, colIdx) => {
    const laneW = laneWidths[colIdx] || 220;
    const laneX = currentLaneX - 10;
    
    const laneBg = svgElement("rect", {
      x: laneX,
      y: "64",
      width: laneW,
      height: height - 78,
      rx: "12",
      fill: colIdx % 2 === 0 ? "#f8fafc" : "#f1f5f9",
      stroke: "#e2e8f0",
      "stroke-width": "1",
      opacity: "0.65",
    });

    const headerBox = svgElement("rect", {
      x: laneX,
      y: "64",
      width: laneW,
      height: "38",
      rx: "8",
      fill: "#ffffff",
      stroke: "#cbd5e1",
      "stroke-width": "1",
    });

    const headerText = svgElement("text", {
      x: laneX + laneW / 2,
      y: "88",
      "text-anchor": "middle",
      fill: "#1e293b",
      "font-size": "13",
      "font-weight": "700",
    });
    headerText.textContent = title;

    swimlaneLayer.append(laneBg, headerBox, headerText);
    currentLaneX += laneW + 16;
  });
  viewport.append(swimlaneLayer);

  const edgeLayer = svgElement("g", { class: "edges" });
  const nodeLayer = svgElement("g", { class: "nodes" });
  viewport.append(edgeLayer, nodeLayer);

  const visibleEdgePaths = () => edgeLayer.querySelectorAll("path[data-edge-visible]");
  const nodeGroupElements = new Map();

  let selectedEdge = null;
  let selectedNode = null;

  // 2. 绘制依赖连线 (基于语义边类型的调色与箭头)
  edges.forEach((edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) return;

    const nodeW = 180;
    let x1, y1, x2, y2, cp1x, cp2x;

    if (Math.abs(source.x - target.x) < 15) {
      // 同一泳道列内的上下垂直连线 (如 Incident 与同列 Exception/RCAHypothesis 的连线)
      const isUpward = source.y > target.y;
      x1 = source.x;
      y1 = source.y + (isUpward ? 14 : 38);
      x2 = target.x;
      y2 = target.y + (isUpward ? 38 : 14);

      const arcOffset = 26;
      cp1x = source.x - arcOffset;
      cp2x = target.x - arcOffset;
    } else if (source.x < target.x) {
      // 跨列：从左侧节点指向右侧节点
      x1 = source.x + nodeW;
      y1 = source.y + 26;
      x2 = target.x;
      y2 = target.y + 26;

      const bend = Math.max(25, Math.abs(x2 - x1) * 0.35);
      cp1x = x1 + bend;
      cp2x = x2 - bend;
    } else {
      // 跨列：从右侧节点指向左侧节点
      x1 = source.x;
      y1 = source.y + 26;
      x2 = target.x + nodeW;
      y2 = target.y + 26;

      const bend = Math.max(25, Math.abs(x1 - x2) * 0.35);
      cp1x = x1 - bend;
      cp2x = x2 + bend;
    }

    const pathData = `M ${x1} ${y1} C ${cp1x} ${y1}, ${cp2x} ${y2}, ${x2} ${y2}`;

    const edgeGroup = svgElement("g", {
      class: "edge-group",
      "data-source": edge.source,
      "data-target": edge.target,
      "data-type": edge.type,
    });
    edgeGroup.style.transition = "opacity 0.2s ease";

    const isFaultEdge = edge.type === "AFFECTS" || edge.type === "FAULT_PROPAGATES_TO";
    const isRootEdge = edge.type === "SUSPECTED_ROOT_CAUSE" || edge.type === "CANDIDATE_CAUSE";

    let strokeColor = edgeColors[edge.type] || "#94a3b8";
    let strokeWidth = isFaultEdge || isRootEdge ? "2.6" : "1.6";
    let markerEnd = "url(#arrow-normal)";

    if (isFaultEdge) {
      strokeColor = "#f43f5e";
      markerEnd = "url(#arrow-affects)";
    } else if (isRootEdge) {
      strokeColor = "#a855f7";
      markerEnd = "url(#arrow-root)";
    }

    const hitPath = svgElement("path", {
      d: pathData,
      fill: "none",
      stroke: "transparent",
      "stroke-width": "16",
      "pointer-events": "stroke",
      tabindex: "0",
      role: "button",
      "aria-label": `关系：${edge.source} ${edge.type} ${edge.target}`,
    });

    const path = svgElement("path", {
      d: pathData,
      fill: "none",
      stroke: strokeColor,
      "stroke-width": strokeWidth,
      "marker-end": markerEnd,
      "pointer-events": "none",
      "data-edge-visible": "true",
    });

    [hitPath, path].forEach((candidate) => {
      candidate.dataset.source = edge.source;
      candidate.dataset.target = edge.target;
      candidate.dataset.type = edge.type;
    });

    hitPath.style.cursor = "pointer";

    const chooseEdge = (event) => {
      event.stopPropagation();
      if (selectedNode) selectedNode.setAttribute("stroke", selectedNode.dataset.originalStroke);
      selectedNode = null;

      Array.from(svg.querySelectorAll("g.edge-group")).forEach((g) => {
        g.style.opacity = "0.1";
      });

      selectedEdge = path;
      edgeGroup.style.opacity = "1";
      path.setAttribute("stroke", "#2563eb");
      path.setAttribute("stroke-width", "3.5");
      onSelectEdge(edge);
    };

    hitPath.addEventListener("click", chooseEdge);
    hitPath.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") chooseEdge(event);
    });

    edgeGroup.append(hitPath, path);

    if (edges.length <= 65) {
      const label = svgElement("text", {
        x: String((x1 + x2) / 2),
        y: String((y1 + y2) / 2 - 6),
        "text-anchor": "middle",
        fill: isFaultEdge ? "#e11d48" : "#475569",
        "font-size": "9.5",
        "font-weight": isFaultEdge ? "700" : "600",
      });
      label.textContent = short(edge.type, 18);
      label.style.pointerEvents = "none";
      edgeGroup.append(label);
    }
    
    edgeLayer.append(edgeGroup);
  });

  // 3. 绘制节点 (纯素雅极简 Text Badges + 精致边框)
  nodes.forEach((node) => {
    const pos = positions.get(node.name);
    const group = svgElement("g", {
      transform: `translate(${pos.x} ${pos.y})`,
      tabindex: "0",
      role: "button",
      "aria-label": `节点：${node.name}，类型：${node.kind || "Component"}`,
      "data-node-name": node.name,
    });
    group.style.cursor = "pointer";
    group.style.transition = "opacity 0.2s ease";

    const color = palette[node.kind] || "#64748b";
    const groupCol = groupFor(node);

    const isStartNode = groupCol === 0;
    const isAffected = affectedNodes.has(node.name);
    const isRootCause = rootCauseNodes.has(node.name);

    let cardBg = "#ffffff";
    let strokeColor = "#cbd5e1";
    let strokeWidth = "1.5";

    if (isAffected && (node.kind === "UIControl" || node.kind === "UIFunction")) {
      cardBg = "#fff1f2";
      strokeColor = "#f43f5e";
      strokeWidth = "2.5";
    } else if (isRootCause) {
      cardBg = "#faf5ff";
      strokeColor = "#a855f7";
      strokeWidth = "3";
    }

    const rect = svgElement("rect", {
      width: "172",
      height: "58",
      rx: "10",
      fill: cardBg,
      stroke: strokeColor,
      "stroke-width": strokeWidth,
    });
    rect.dataset.originalStroke = strokeColor;

    const accent = svgElement("rect", {
      width: "6",
      height: "58",
      rx: "3",
      fill: color,
    });

    const title = svgElement("text", {
      x: "16",
      y: "25",
      fill: isAffected ? "#9f1239" : "#0f172a",
      "font-size": "12.5",
      "font-weight": "700",
    });
    title.textContent = short(node.name, 17);

    const kind = svgElement("text", {
      x: "16",
      y: "43",
      fill: "#64748b",
      "font-size": "10",
    });
    kind.textContent = node.kind || "Component";

    group.append(rect, accent, title, kind);

    if (isRootCause) {
      group.classList.add("node-root-glow");
    } else if (isAffected) {
      group.classList.add("node-fault-glow");
    }

    const isInfraNode = ["Host", "Pod", "Database", "Cache", "NetworkSwitch"].includes(node.kind);

    // 纯素雅极简徽章 (精细适配 172px 节点卡片宽)
    if (isStartNode) {
      const badgeG = svgElement("g", { transform: "translate(130, 6)" });
      const badgeBg = svgElement("rect", {
        width: "34",
        height: "18",
        rx: "9",
        fill: isAffected ? "#ffe4e6" : "#f1f5f9",
        stroke: isAffected ? "#f43f5e" : "#cbd5e1",
        "stroke-width": "1",
      });
      const badgeTxt = svgElement("text", {
        x: "17",
        y: "13",
        "text-anchor": "middle",
        fill: isAffected ? "#be123c" : "#475569",
        "font-size": "9",
        "font-weight": "700",
      });
      badgeTxt.textContent = isAffected ? "异常" : "起点";
      badgeG.append(badgeBg, badgeTxt);
      group.append(badgeG);
    } else if (isRootCause) {
      const badgeG = svgElement("g", { transform: "translate(114, 6)" });
      const badgeBg = svgElement("rect", {
        width: "50",
        height: "18",
        rx: "9",
        fill: "#f3e8ff",
        stroke: "#9333ea",
        "stroke-width": "1",
      });
      const badgeTxt = svgElement("text", {
        x: "25",
        y: "13",
        "text-anchor": "middle",
        fill: "#7e22ce",
        "font-size": "9",
        "font-weight": "700",
      });
      badgeTxt.textContent = "根因起点";
      badgeG.append(badgeBg, badgeTxt);
      group.append(badgeG);
    } else if (isAffected) {
      const badgeG = svgElement("g", { transform: "translate(122, 6)" });
      const badgeBg = svgElement("rect", {
        width: "42",
        height: "18",
        rx: "9",
        fill: "#fff1f2",
        stroke: "#f43f5e",
        "stroke-width": "1",
      });
      const badgeTxt = svgElement("text", {
        x: "21",
        y: "13",
        "text-anchor": "middle",
        fill: "#be123c",
        "font-size": "9",
        "font-weight": "700",
      });
      badgeTxt.textContent = "受波及";
      badgeG.append(badgeBg, badgeTxt);
      group.append(badgeG);
    } else if (isInfraNode) {
      const badgeG = svgElement("g", { transform: "translate(114, 6)" });
      const badgeBg = svgElement("rect", {
        width: "50",
        height: "18",
        rx: "9",
        fill: "#f8fafc",
        stroke: "#cbd5e1",
        "stroke-width": "1",
      });
      const badgeTxt = svgElement("text", {
        x: "25",
        y: "13",
        "text-anchor": "middle",
        fill: "#64748b",
        "font-size": "8.5",
        "font-weight": "700",
      });
      badgeTxt.textContent = "基础设施";
      badgeG.append(badgeBg, badgeTxt);
      group.append(badgeG);
    }

    const browserTitle = svgElement("title");
    browserTitle.textContent = `${node.name} · ${node.kind}\n${node.description || ""}`;
    group.append(browserTitle);

    nodeGroupElements.set(node.name, group);

    const choose = () => {
      if (selectedNode) selectedNode.setAttribute("stroke", selectedNode.dataset.originalStroke);
      selectedEdge = null;
      selectedNode = rect;
      rect.setAttribute("stroke", "#2563eb");
      rect.setAttribute("stroke-width", "3");

      const allEdgeGroups = Array.from(svg.querySelectorAll("g.edge-group"));
      const neighborNodes = new Set([node.name]);

      allEdgeGroups.forEach((g) => {
        const isNeighbor = g.dataset.source === node.name || g.dataset.target === node.name;
        if (isNeighbor) {
          neighborNodes.add(g.dataset.source);
          neighborNodes.add(g.dataset.target);
          g.style.opacity = "1";
          const path = g.querySelector("path[data-edge-visible]");
          if (path) {
            path.setAttribute("stroke", path.dataset.type === "AFFECTS" ? "#f43f5e" : "#2563eb");
            path.setAttribute("stroke-width", "3");
          }
        } else {
          g.style.opacity = "0.06";
          const path = g.querySelector("path[data-edge-visible]");
          if (path) {
            path.setAttribute("stroke", "#cbd5e1");
            path.setAttribute("stroke-width", "1");
          }
        }
      });

      nodeGroupElements.forEach((el, name) => {
        el.style.opacity = neighborNodes.has(name) ? "1" : "0.2";
      });

      onSelect(node, edges.filter((edge) => edge.source === node.name || edge.target === node.name));
    };

    group.addEventListener("mouseenter", () => {
      if (selectedNode) return;
      const neighborNodes = new Set([node.name]);
      const allEdgeGroups = Array.from(svg.querySelectorAll("g.edge-group"));

      allEdgeGroups.forEach((g) => {
        const isNeighbor = g.dataset.source === node.name || g.dataset.target === node.name;
        if (isNeighbor) {
          neighborNodes.add(g.dataset.source);
          neighborNodes.add(g.dataset.target);
        }
        g.style.opacity = isNeighbor ? "1" : "0.06";
      });
      nodeGroupElements.forEach((el, name) => {
        el.style.opacity = neighborNodes.has(name) ? "1" : "0.2";
      });
    });

    group.addEventListener("mouseleave", () => {
      if (selectedNode) return;
      Array.from(svg.querySelectorAll("g.edge-group")).forEach((g) => {
        g.style.opacity = "1";
        const path = g.querySelector("path[data-edge-visible]");
        if (path) {
          const isFaultEdge = g.dataset.type === "AFFECTS" || g.dataset.type === "FAULT_PROPAGATES_TO";
          const isRootEdge = g.dataset.type === "SUSPECTED_ROOT_CAUSE" || g.dataset.type === "CANDIDATE_CAUSE";
          path.setAttribute("stroke", isFaultEdge ? "#f43f5e" : isRootEdge ? "#a855f7" : (edgeColors[g.dataset.type] || "#94a3b8"));
          path.setAttribute("stroke-width", isFaultEdge || isRootEdge ? "2.6" : "1.6");
        }
      });
      nodeGroupElements.forEach((el) => {
        el.style.opacity = "1";
      });
    });

    group.addEventListener("click", (event) => {
      event.stopPropagation();
      choose();
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter") choose();
    });

    nodeLayer.append(group);
  });

  let scale = 1;
  let panX = 0;
  let panY = 0;
  let dragging = false;
  let start = { x: 0, y: 0 };

  const transform = () => viewport.setAttribute("transform", `translate(${panX} ${panY}) scale(${scale})`);
  const zoom = (factor) => {
    scale = Math.max(0.35, Math.min(2.4, scale * factor));
    transform();
  };
  const reset = () => {
    scale = 1;
    panX = 0;
    panY = 0;
    transform();
  };

  svg.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1.1 : 0.9);
    },
    { passive: false }
  );

  let lastDownPos = { x: 0, y: 0 };

  svg.addEventListener("pointerdown", (event) => {
    lastDownPos = { x: event.clientX, y: event.clientY };
    if (event.target !== svg && event.target.tagName !== "rect" && !event.target.closest(".swimlanes")) return;
    dragging = true;
    start = { x: event.clientX - panX, y: event.clientY - panY };
    svg.setPointerCapture?.(event.pointerId);
  });
  svg.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    panX = event.clientX - start.x;
    panY = event.clientY - start.y;
    transform();
  });
  svg.addEventListener("pointerup", () => {
    dragging = false;
  });
  svg.addEventListener("pointercancel", () => {
    dragging = false;
  });

  svg.addEventListener("click", (event) => {
    // 如果鼠标按下和抬起的物理移动距离 > 5 像素，说明用户是在平移拖动画布 (Drag)，绝对不取消高亮！
    const moveDist = Math.hypot(event.clientX - lastDownPos.x, event.clientY - lastDownPos.y);
    if (moveDist > 5) return;

    if (event.target === svg || event.target.tagName === "rect") {
      selectedEdge = null;
      if (selectedNode) selectedNode.setAttribute("stroke", selectedNode.dataset.originalStroke);
      selectedNode = null;
      Array.from(svg.querySelectorAll("g.edge-group")).forEach((g) => {
        g.style.opacity = "1";
        const path = g.querySelector("path[data-edge-visible]");
        if (path) {
          const isFaultEdge = g.dataset.type === "AFFECTS" || g.dataset.type === "FAULT_PROPAGATES_TO";
          const isRootEdge = g.dataset.type === "SUSPECTED_ROOT_CAUSE" || g.dataset.type === "CANDIDATE_CAUSE";
          path.setAttribute("stroke", isFaultEdge ? "#f43f5e" : isRootEdge ? "#a855f7" : (edgeColors[g.dataset.type] || "#94a3b8"));
          path.setAttribute("stroke-width", isFaultEdge || isRootEdge ? "2.6" : "1.6");
        }
      });
      nodeGroupElements.forEach((el) => {
        el.style.opacity = "1";
      });
    }
  });

  container.append(svg);
  return {
    zoomIn: () => zoom(1.18),
    zoomOut: () => zoom(0.84),
    reset,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
}

export function graphLegend(includeDynamic = true) {
  const entries = [
    ["UIControl", "UI控件 (起点)"],
    ["UIFunction", "页面功能"],
    ["Service", "服务"],
    ["Database", "数据库/缓存"],
    ["Host", "宿主机"],
    ["Pod", "容器"],
  ];
  if (includeDynamic) entries.push(["Incident", "故障"], ["RCAHypothesis", "根因假说"]);
  return entries
    .map(
      ([kind, label]) =>
        `<span><i class="legend-dot" style="background:${palette[kind]}"></i>${label}</span>`
    )
    .join("");
}
