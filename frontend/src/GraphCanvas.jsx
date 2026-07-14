import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { DataSet, Network } from 'vis-network/standalone';
import 'vis-network/styles/vis-network.css';
import {
  KIND_THEME,
  connectedNodeIds,
  degreeMap,
  escapeHtml,
  getNodeId,
  getNodeKind,
  getNodeName,
  getRelationType,
  relationColor,
  rgba,
  safeString,
  shortenLabel,
  wrapLabel
} from './graphTheme.js';

function tooltipNode(node, degree) {
  const kind = getNodeKind(node);
  return [
    '<div class="kg-tooltip">',
    `<div class="kg-tooltip-title">${escapeHtml(getNodeName(node))}</div>`,
    `<div><b>类型</b><span>${escapeHtml(kind)}</span></div>`,
    node.layer ? `<div><b>层级</b><span>${escapeHtml(node.layer)}</span></div>` : '',
    `<div><b>度数</b><span>${degree}</span></div>`,
    node.description ? `<p>${escapeHtml(node.description)}</p>` : '',
    `<small>${escapeHtml(getNodeId(node))}</small>`,
    '</div>'
  ].filter(Boolean).join('');
}

function tooltipEdge(edge) {
  return [
    '<div class="kg-tooltip">',
    `<div class="kg-tooltip-title">${escapeHtml(getRelationType(edge))}</div>`,
    `<div><b>From</b><span>${escapeHtml(edge.source)}</span></div>`,
    `<div><b>To</b><span>${escapeHtml(edge.target)}</span></div>`,
    edge.description ? `<p>${escapeHtml(edge.description)}</p>` : '',
    '</div>'
  ].filter(Boolean).join('');
}

function nodeSizeByDegree(kind, degree, stats) {
  const safeDegree = Math.max(0, Number(degree) || 0);
  const maxDegree = Math.max(1, Number(stats?.maxDegree) || 1);
  const total = Number(stats?.total) || 0;
  const large = total > 900;
  const huge = total > 2200;

  // 成熟图数据库浏览器常用“类别决定颜色、连接度决定大小”的编码方式。
  // 使用 log 比例避免超级枢纽节点过大，同时让 1~3 条边的小节点也能看出差异。
  const min = huge ? 16 : large ? 18 : 22;
  const max = huge ? 46 : large ? 54 : 72;
  const normalized = Math.log1p(safeDegree) / Math.log1p(maxDegree);
  const curved = Math.pow(Math.min(1, normalized), 0.72);

  const kindBoost = {
    System: 6,
    Layer: 3,
    Service: 1.5,
    Database: 1,
    Middleware: 0.5,
    Queue: 0.5,
    API: 0,
    Function: -1,
    Component: -1
  }[kind] || 0;

  return Math.max(min, Math.min(max, min + curved * (max - min) + kindBoost));
}

function degreeStats(nodes, edges) {
  const degrees = degreeMap(nodes, edges);
  let maxDegree = 0;
  for (const value of degrees.values()) maxDegree = Math.max(maxDegree, value || 0);
  return { degrees, maxDegree, total: nodes.length + edges.length };
}

function edgeId(edge, index) {
  return safeString(edge.id || edge.relation_id || `${edge.source}::${getRelationType(edge)}::${edge.target}::${index}`);
}

function makeNode(node, degree, stats, selectedSet, selectedId) {
  const id = getNodeId(node);
  const kind = getNodeKind(node);
  const meta = KIND_THEME[kind] || KIND_THEME.Component;
  const hasSelection = selectedSet && selectedSet.size > 0;
  const selected = id === selectedId;
  const dimmed = hasSelection && !selectedSet.has(id);
  const total = Number(stats?.total) || 0;
  const maxDegree = Math.max(1, Number(stats?.maxDegree) || 1);
  const centrality = Math.min(1, Math.max(0, degree / maxDegree));
  const isLarge = total > 650;
  const isHub = degree >= 6 || centrality >= 0.42;
  const label = isLarge && degree < 2 && !selected ? '' : wrapLabel(getNodeName(node), isLarge ? 7 : 8, isLarge ? 18 : 26);
  const size = nodeSizeByDegree(kind, degree, stats);

  return {
    id,
    label,
    level: meta.level,
    shape: 'circle',
    size,
    value: size,
    mass: Math.min(9, 1 + Math.sqrt(degree + 1) / 2.15),
    borderWidth: selected ? 5 : isHub ? 3 : 2,
    color: {
      background: dimmed ? 'rgba(226,232,240,.52)' : meta.color,
      border: dimmed ? 'rgba(148,163,184,.42)' : meta.border,
      highlight: { background: meta.color, border: '#111827' },
      hover: { background: meta.color, border: '#111827' }
    },
    font: {
      color: dimmed ? 'rgba(255,255,255,.48)' : '#ffffff',
      size: selected ? 16 : isHub ? (isLarge ? 12 : 14) : isLarge ? 10 : 12,
      vadjust: 0,
      bold: { color: '#ffffff', size: selected ? 15 : 12, face: 'Inter, Microsoft YaHei, Arial, sans-serif' },
      face: 'Inter, Microsoft YaHei, Arial, sans-serif',
      multi: false,
      strokeWidth: 0
    },
    shadow: selected
      ? { enabled: true, color: rgba(meta.color, 0.44), size: 34, x: 0, y: 0 }
      : { enabled: isHub || (!isLarge && !dimmed), color: isHub ? rgba(meta.color, 0.24) : 'rgba(15,23,42,.18)', size: isHub ? 20 : 12, x: 0, y: isHub ? 4 : 5 },
    data: { ...node, _degree: degree, _size: Math.round(size), _kind: kind }
  };
}

function makeEdge(edge, index, total, selectedSet, selectedEdgeId) {
  const type = getRelationType(edge);
  const color = relationColor(type);
  const id = edgeId(edge, index);
  const source = safeString(edge.source);
  const target = safeString(edge.target);
  const hasSelection = selectedSet && selectedSet.size > 0;
  const connected = hasSelection && selectedSet.has(source) && selectedSet.has(target);
  const dimmed = hasSelection && !connected;
  const large = total > 650;
  const huge = total > 1400;
  const selected = id === selectedEdgeId;
  const showLabel = selected || (!large && !hasSelection) || (connected && !huge);

  return {
    id,
    from: source,
    to: target,
    label: showLabel ? shortenLabel(type, 22) : '',
    arrows: { to: { enabled: true, type: 'arrow', scaleFactor: huge ? 0.38 : 0.55 } },
    color: {
      color: dimmed ? 'rgba(203,213,225,.25)' : rgba(color, hasSelection ? 0.72 : 0.55),
      highlight: color,
      hover: color,
      inherit: false
    },
    width: selected ? 2.6 : dimmed ? 0.35 : large ? 0.85 : 1.2,
    selectionWidth: 3,
    hoverWidth: 2,
    smooth: {
      enabled: true,
      type: huge ? 'continuous' : 'dynamic',
      roundness: 0.18
    },
    font: {
      align: 'middle',
      size: large ? 9 : 10,
      color: selected ? '#0f172a' : '#334155',
      face: 'Inter, Microsoft YaHei, Arial, sans-serif',
      strokeWidth: 4,
      strokeColor: 'rgba(255,255,255,.96)'
    },
    data: edge
  };
}


function GraphHoverTooltip({ tooltip }) {
  if (!tooltip?.item) return null;
  const item = tooltip.item;
  const isNode = tooltip.type === 'node';

  return (
    <div className="kg-hover-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
      <div className="kg-hover-tooltip-title">
        {isNode ? getNodeName(item) : getRelationType(item)}
      </div>
      {isNode ? (
        <>
          <div className="kg-hover-row"><b>类型</b><span>{getNodeKind(item)}</span></div>
          {item.layer && <div className="kg-hover-row"><b>层级</b><span>{safeString(item.layer)}</span></div>}
          {tooltip.degree !== undefined && <div className="kg-hover-row"><b>度数</b><span>{tooltip.degree}</span></div>}
          {item.description && <p>{safeString(item.description)}</p>}
          <small>{getNodeId(item)}</small>
        </>
      ) : (
        <>
          <div className="kg-hover-row"><b>From</b><span>{safeString(item.source)}</span></div>
          <div className="kg-hover-row"><b>To</b><span>{safeString(item.target)}</span></div>
          {item.description && <p>{safeString(item.description)}</p>}
        </>
      )}
    </div>
  );
}

const GraphCanvas = forwardRef(function GraphCanvas({ graph, onBusyChange, onSelectionChange, onSceneInfo }, ref) {
  const containerRef = useRef(null);
  const networkRef = useRef(null);
  const nodeDataRef = useRef(null);
  const edgeDataRef = useRef(null);
  const nodeLookupRef = useRef(new Map());
  const edgeLookupRef = useRef(new Map());
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [selectedEdgeId, setSelectedEdgeId] = useState('');
  const [hoverTip, setHoverTip] = useState(null);

  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const graphTotal = nodes.length + edges.length;
  const isLarge = nodes.length > 650 || edges.length > 1300;
  const isHuge = nodes.length > 1500 || edges.length > 2600;

  const selectedSet = useMemo(() => {
    if (!selectedNodeId) return new Set();
    return connectedNodeIds(selectedNodeId, edges);
  }, [selectedNodeId, edges]);

  const prepared = useMemo(() => {
    const stats = degreeStats(nodes, edges);
    const nodeIds = new Set(nodes.map(getNodeId));
    const visNodes = nodes.map(node => makeNode(node, stats.degrees.get(getNodeId(node)) || 0, stats, selectedSet, selectedNodeId));
    const visEdges = edges
      .filter(edge => nodeIds.has(safeString(edge.source)) && nodeIds.has(safeString(edge.target)))
      .map((edge, index) => makeEdge(edge, index, graphTotal, selectedSet, selectedEdgeId));
    return { nodes: visNodes, edges: visEdges, stats };
  }, [nodes, edges, graphTotal, selectedSet, selectedNodeId, selectedEdgeId]);

  useEffect(() => {
    nodeLookupRef.current = new Map(prepared.nodes.map(node => [safeString(node.id), node.data]));
    edgeLookupRef.current = new Map(prepared.edges.map(edge => [safeString(edge.id), edge.data]));
  }, [prepared]);

  useEffect(() => {
    if (!containerRef.current) return undefined;

    if (networkRef.current) {
      networkRef.current.destroy();
      networkRef.current = null;
    }

    const nodeData = new DataSet(prepared.nodes);
    const edgeData = new DataSet(prepared.edges);
    nodeDataRef.current = nodeData;
    edgeDataRef.current = edgeData;

    const network = new Network(containerRef.current, { nodes: nodeData, edges: edgeData }, {
      autoResize: true,
      width: '100%',
      height: '100%',
      configure: { enabled: false },
      layout: {
        randomSeed: 42,
        improvedLayout: !isHuge,
        hierarchical: {
          enabled: false
        }
      },
      interaction: {
        hover: true,
        hoverConnectedEdges: true,
        selectable: true,
        selectConnectedEdges: true,
        multiselect: false,
        dragView: true,
        dragNodes: !isHuge,
        zoomView: true,
        hideEdgesOnDrag: isLarge,
        hideEdgesOnZoom: isHuge,
        tooltipDelay: 100,
        navigationButtons: false,
        keyboard: { enabled: true, bindToWindow: false }
      },
      physics: {
        enabled: !isHuge,
        solver: isLarge ? 'forceAtlas2Based' : 'barnesHut',
        stabilization: {
          enabled: true,
          iterations: isLarge ? 260 : 520,
          updateInterval: 30,
          fit: true
        },
        barnesHut: {
          gravitationalConstant: -7400,
          centralGravity: 0.11,
          springLength: 185,
          springConstant: 0.032,
          damping: 0.44,
          avoidOverlap: 0.62
        },
        forceAtlas2Based: {
          gravitationalConstant: -88,
          centralGravity: 0.014,
          springLength: 190,
          springConstant: 0.055,
          damping: 0.58,
          avoidOverlap: 0.82
        },
        minVelocity: 0.85,
        maxVelocity: 38
      },
      nodes: {
        chosen: {
          node(values) {
            values.borderWidth = Math.max(values.borderWidth || 2, 5);
            values.shadow = true;
            values.shadowSize = 34;
          },
          label(values) {
            values.size = Math.max(values.size || 12, 15);
          }
        },
        scaling: { min: 16, max: 76, label: { enabled: false } }
      },
      edges: {
        chosen: true,
        selfReferenceSize: 18,
        endPointOffset: { from: 0, to: 1 }
      }
    });

    networkRef.current = network;
    onBusyChange?.(true);

    const currentDegree = prepared.stats?.degrees || degreeMap(nodes, edges);
    const placeTooltip = (event, type, item) => {
      const point = event?.pointer?.DOM || { x: 0, y: 0 };
      const width = containerRef.current?.clientWidth || 0;
      const height = containerRef.current?.clientHeight || 0;
      const x = Math.max(12, Math.min(point.x + 16, Math.max(12, width - 390)));
      const y = Math.max(96, Math.min(point.y + 16, Math.max(96, height - 260)));
      setHoverTip({
        type,
        item,
        x,
        y,
        degree: type === 'node' ? currentDegree.get(getNodeId(item)) || 0 : undefined
      });
    };

    network.on('hoverNode', event => {
      const id = safeString(event.node);
      const node = nodeLookupRef.current.get(id);
      if (node) placeTooltip(event, 'node', node);
    });

    network.on('blurNode', () => setHoverTip(null));

    network.on('hoverEdge', event => {
      const id = safeString(event.edge);
      const edge = edgeLookupRef.current.get(id);
      if (edge) placeTooltip(event, 'edge', edge);
    });

    network.on('blurEdge', () => setHoverTip(null));
    network.on('dragStart', () => setHoverTip(null));

    network.once('stabilized', () => {
      onBusyChange?.(false);
      if (isLarge) network.setOptions({ physics: { enabled: false } });
      window.setTimeout(() => network.fit({ animation: { duration: 450, easingFunction: 'easeInOutQuad' } }), 50);
    });

    network.on('selectNode', event => {
      const id = safeString(event.nodes?.[0]);
      setSelectedNodeId(id);
      setSelectedEdgeId('');
      const node = nodeLookupRef.current.get(id);
      onSelectionChange?.(node ? { type: 'node', item: node } : null);
    });

    network.on('selectEdge', event => {
      const id = safeString(event.edges?.[0]);
      if (!id) return;
      setSelectedEdgeId(id);
      const edge = edgeLookupRef.current.get(id);
      onSelectionChange?.(edge ? { type: 'edge', item: edge } : null);
    });

    network.on('deselectNode', event => {
      if (!event.edges?.length) {
        setSelectedNodeId('');
        onSelectionChange?.(null);
      }
    });

    network.on('deselectEdge', event => {
      if (!event.nodes?.length) {
        setSelectedEdgeId('');
        onSelectionChange?.(null);
      }
    });

    network.on('doubleClick', event => {
      setHoverTip(null);
      const id = safeString(event.nodes?.[0]);
      if (id) {
        network.focus(id, { scale: 1.25, animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
      }
    });

    network.on('zoom', params => {
      setHoverTip(null);
      onSceneInfo?.({ scale: params.scale });
    });

    return () => {
      network.destroy();
      networkRef.current = null;
    };
  }, [prepared, isLarge, isHuge, onBusyChange, onSelectionChange, onSceneInfo]);

  useEffect(() => {
    if (!networkRef.current || !nodeDataRef.current || !edgeDataRef.current) return;
    nodeDataRef.current.update(prepared.nodes);
    edgeDataRef.current.update(prepared.edges);
  }, [prepared]);

  useImperativeHandle(ref, () => ({
    fit() {
      networkRef.current?.fit({ animation: { duration: 480, easingFunction: 'easeInOutQuad' } });
    },
    refreshLayout() {
      if (!networkRef.current) return;
      networkRef.current.setOptions({ physics: { enabled: true } });
      networkRef.current.stabilize(isLarge ? 180 : 360);
    },
    clearSelection() {
      setSelectedNodeId('');
      setSelectedEdgeId('');
      setHoverTip(null);
      networkRef.current?.unselectAll();
      onSelectionChange?.(null);
    }
  }), [isLarge, onSelectionChange]);

  if (!nodes.length) {
    return (
      <div className="kg-empty">
        <div className="kg-empty-orbit" />
        <h2>上传系统说明文件，生成知识图谱</h2>
        <p>支持 .txt / .md / .yaml / .yml。图谱会以节点关系网络形式直接展示在这里。</p>
      </div>
    );
  }

  return (
    <div className="kg-canvas-layer">
      <div ref={containerRef} className="kg-network" />
      <GraphHoverTooltip tooltip={hoverTip} />
    </div>
  );
});

export default GraphCanvas;
