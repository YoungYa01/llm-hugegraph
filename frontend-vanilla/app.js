(() => {
  'use strict';

  const API_BASE = window.LOGSYS_API_BASE || localStorage.getItem('LOGSYS_API_BASE') || 'http://127.0.0.1:8000';
  const QUERY_LIMIT = 5000;
  const RENDER_LIMIT = 1600;

  const KIND_THEME = {
    System: { label: '系统', color: '#2563eb', border: '#1d4ed8', level: 0, hint: '系统/平台根节点' },
    Layer: { label: '层级', color: '#7c3aed', border: '#6d28d9', level: 1, hint: '架构层次' },
    Service: { label: '服务', color: '#0891b2', border: '#0e7490', level: 2, hint: '微服务/应用服务' },
    API: { label: '接口', color: '#db2777', border: '#be185d', level: 2, hint: '网关/API' },
    Database: { label: '数据库', color: '#16a34a', border: '#15803d', level: 3, hint: 'MySQL/PostgreSQL 等' },
    Middleware: { label: '中间件', color: '#ea580c', border: '#c2410c', level: 3, hint: 'Redis/Nginx/ES 等' },
    Queue: { label: '队列', color: '#ca8a04', border: '#a16207', level: 3, hint: 'Kafka/RabbitMQ 等' },
    Function: { label: '功能', color: '#475569', border: '#334155', level: 4, hint: '业务能力/功能点' },
    Incident: { label: '故障', color: '#dc2626', border: '#991b1b', level: 1, hint: '一次合并后的异常事件' },
    Trace: { label: 'Trace', color: '#f97316', border: '#c2410c', level: 2, hint: '主 traceId / 链路' },
    LogEvent: { label: '日志事件', color: '#ef4444', border: '#b91c1c', level: 5, hint: '异常日志/候选证据' },
    Exception: { label: '异常', color: '#be123c', border: '#9f1239', level: 1, hint: '根因异常类/错误' },
    Window: { label: '窗口', color: '#a855f7', border: '#7e22ce', level: 4, hint: '滑动窗口异常' },
    Metric: { label: '指标', color: '#0d9488', border: '#0f766e', level: 4, hint: '模型/统计指标' },
    Host: { label: '主机', color: '#334155', border: '#1e293b', level: 4, hint: '主机/实例' },
    Pod: { label: 'Pod', color: '#0284c7', border: '#0369a1', level: 4, hint: '容器/Pod 实例' },
    Component: { label: '组件', color: '#64748b', border: '#475569', level: 4, hint: '其它组件' }
  };

  const RELATION_THEME = {
    CALLS: '#2563eb', USES_DB: '#16a34a', CONTAINS: '#7c3aed', BELONGS_TO_LAYER: '#8b5cf6',
    PROVIDES: '#db2777', DEPENDS_ON: '#ea580c', READS: '#0d9488', WRITES: '#059669',
    PUBLISHES: '#ca8a04', SUBSCRIBES: '#9333ea', HAS_TRACE: '#f97316', HAS_EVENT: '#ef4444',
    OBSERVED_IN: '#dc2626', ROOT_CAUSE: '#be123c', ROOT_SERVICE: '#dc2626', EMITS: '#ef4444',
    CAUSES: '#b91c1c', PROPAGATES_TO: '#f97316', ERROR_PROPAGATES_TO: '#dc2626', TRIGGERED_BY: '#be123c',
    AFFECTS: '#dc2626', RELATION: '#64748b'
  };

  const RELATION_TYPES = Object.keys(RELATION_THEME).filter(x => x !== 'RELATION');
  const activeKinds = new Set(Object.keys(KIND_THEME));
  let currentGraph = { nodes: [], edges: [], warnings: [] };
  let modalState = { type: 'node', mode: 'create', item: null, originalName: '' };

  const KIND_ALIASES = new Map([
    ['system', 'System'], ['系统', 'System'], ['应用系统', 'System'], ['平台', 'System'],
    ['layer', 'Layer'], ['层', 'Layer'], ['层级', 'Layer'], ['架构层', 'Layer'],
    ['service', 'Service'], ['服务', 'Service'], ['微服务', 'Service'], ['应用服务', 'Service'], ['application', 'Service'], ['app', 'Service'], ['svc', 'Service'],
    ['database', 'Database'], ['db', 'Database'], ['数据库', 'Database'], ['数据存储', 'Database'], ['mysql', 'Database'], ['postgresql', 'Database'], ['postgres', 'Database'], ['oracle', 'Database'], ['mongodb', 'Database'],
    ['middleware', 'Middleware'], ['中间件', 'Middleware'], ['redis', 'Middleware'], ['cache', 'Middleware'], ['缓存', 'Middleware'], ['elasticsearch', 'Middleware'], ['es', 'Middleware'], ['nginx', 'Middleware'],
    ['queue', 'Queue'], ['mq', 'Queue'], ['消息队列', 'Queue'], ['kafka', 'Queue'], ['rabbitmq', 'Queue'], ['rocketmq', 'Queue'], ['pulsar', 'Queue'],
    ['api', 'API'], ['接口', 'API'], ['gateway api', 'API'], ['rest api', 'API'], ['http api', 'API'],
    ['function', 'Function'], ['功能', 'Function'], ['用例', 'Function'], ['能力', 'Function'],
    ['incident', 'Incident'], ['故障', 'Incident'], ['异常事件', 'Incident'],
    ['trace', 'Trace'], ['traceid', 'Trace'], ['链路', 'Trace'],
    ['logevent', 'LogEvent'], ['日志', 'LogEvent'], ['异常日志', 'LogEvent'],
    ['exception', 'Exception'], ['error', 'Exception'], ['异常', 'Exception'],
    ['window', 'Window'], ['滑动窗口', 'Window'], ['窗口', 'Window'],
    ['metric', 'Metric'], ['指标', 'Metric'], ['host', 'Host'], ['主机', 'Host'], ['pod', 'Pod'], ['容器', 'Pod'],
    ['component', 'Component'], ['组件', 'Component'], ['模块', 'Component'], ['module', 'Component']
  ]);

  function $(id) { return document.getElementById(id); }
  function safeString(value, fallback = '') { return value === undefined || value === null ? fallback : String(value); }
  function getNodeId(node) { return safeString(node && (node.id || node.uid || node.name)); }
  function getNodeName(node) { return safeString(node && (node.name || node.label || node.id || node.uid || '未命名节点')); }
  function getRelationType(edge) { return safeString(edge && (edge.type || edge.relation_type || edge.label || 'RELATION')).toUpperCase(); }
  function normalizeKind(value) {
    const raw = safeString(value || 'Component').trim();
    if (KIND_THEME[raw]) return raw;
    const compact = raw.toLowerCase().replace(/[\s_]+/g, ' ').trim();
    if (KIND_ALIASES.has(compact)) return KIND_ALIASES.get(compact);
    const noSpace = compact.replace(/[-\s]/g, '');
    if (KIND_ALIASES.has(noSpace)) return KIND_ALIASES.get(noSpace);
    if (/incident|故障/.test(compact)) return 'Incident';
    if (/trace|链路/.test(compact)) return 'Trace';
    if (/log|日志/.test(compact)) return 'LogEvent';
    if (/exception|error|异常/.test(compact)) return 'Exception';
    if (/mysql|postgres|oracle|mongo|database|db|数据库/.test(compact)) return 'Database';
    if (/kafka|rabbit|rocket|pulsar|queue|mq|消息/.test(compact)) return 'Queue';
    if (/redis|cache|nginx|elastic|middleware|中间件/.test(compact)) return 'Middleware';
    if (/api|接口|gateway/.test(compact)) return 'API';
    if (/service|server|svc|服务/.test(compact)) return 'Service';
    if (/layer|层/.test(compact)) return 'Layer';
    if (/function|功能|能力/.test(compact)) return 'Function';
    if (/system|系统|平台/.test(compact)) return 'System';
    return 'Component';
  }
  function getNodeKind(node) { return normalizeKind(node && (node.kind || node.type || 'Component')); }
  function relationColor(type) { return RELATION_THEME[type] || RELATION_THEME.RELATION; }
  function hexToRgb(hex) {
    const value = safeString(hex).replace('#', '');
    const normalized = value.length === 3 ? value.split('').map(ch => ch + ch).join('') : value;
    const num = parseInt(normalized, 16);
    if (Number.isNaN(num)) return [100, 116, 139];
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }
  function rgba(hex, alpha) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${alpha})`; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function escapeHtml(value) { return safeString(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch])); }
  function shorten(text, max = 20) { const s = safeString(text).trim(); return s.length <= max ? s : `${s.slice(0, max - 1)}…`; }
  function nowTime() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }
  function metaObject(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed }; } catch { return { text: String(value) }; }
  }
  function parseMetaInput(text) {
    const s = safeString(text).trim();
    if (!s) return {};
    const parsed = JSON.parse(s);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Meta JSON 必须是对象，例如 {"owner":"team-a"}');
    return parsed;
  }

  async function request(path, options = {}) {
    const resp = await fetch(`${API_BASE}${path}`, options);
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!resp.ok) {
      const detail = typeof data === 'object' && data ? (data.detail || data.message || JSON.stringify(data)) : text;
      throw new Error(detail || `${resp.status} ${resp.statusText}`);
    }
    return data;
  }
  function normalizeGraphPayload(payload) {
    return {
      nodes: Array.isArray(payload && payload.nodes) ? payload.nodes : [],
      edges: Array.isArray(payload && payload.edges) ? payload.edges : [],
      warnings: Array.isArray(payload && payload.warnings) ? payload.warnings : []
    };
  }
  async function fetchGraph(limit = QUERY_LIMIT) { return normalizeGraphPayload(await request(`/api/graph?limit=${limit}`)); }
  async function importKnowledgeFile(file) { const form = new FormData(); form.append('file', file); return request('/api/import', { method: 'POST', body: form }); }
  async function importIncidentFile(file) { const form = new FormData(); form.append('file', file); return request('/api/incidents/import', { method: 'POST', body: form }); }
  async function analyzeLogsFile(file) { const form = new FormData(); form.append('file', file); return request('/api/logs/analyze', { method: 'POST', body: form }); }
  async function clearKnowledgeGraph() { return request('/api/clear', { method: 'POST' }); }
  async function saveNode(payload, originalName = '') {
    const body = JSON.stringify(payload);
    return originalName ? request(`/api/nodes/${encodeURIComponent(originalName)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
      : request('/api/nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  }
  async function saveEdge(payload) { return request('/api/edges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
  async function deleteNode(name) { return request(`/api/nodes/${encodeURIComponent(name)}`, { method: 'DELETE' }); }
  async function deleteEdge(edge) { return request('/api/edges/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: edge.source.id, target: edge.target.id, type: edge.type }) }); }

  function degreeMap(nodes, edges) {
    const ids = new Set(nodes.map(getNodeId));
    const degrees = new Map(nodes.map(node => [getNodeId(node), 0]));
    for (const edge of edges) {
      const s = safeString(edge.source); const t = safeString(edge.target);
      if (ids.has(s)) degrees.set(s, (degrees.get(s) || 0) + 1);
      if (ids.has(t)) degrees.set(t, (degrees.get(t) || 0) + 1);
    }
    return degrees;
  }
  function filteredGraph(graph) {
    const nodes = (graph.nodes || []).filter(n => activeKinds.has(getNodeKind(n)));
    const keep = new Set(nodes.map(getNodeId));
    const edges = (graph.edges || []).filter(e => keep.has(safeString(e.source)) && keep.has(safeString(e.target)));
    return { nodes, edges, warnings: graph.warnings || [] };
  }
  function topologicalSlice(graph, maxNodes = RENDER_LIMIT) {
    const filtered = filteredGraph(graph);
    const nodes = filtered.nodes;
    const edges = filtered.edges;
    if (nodes.length <= maxNodes) return { nodes, edges, sliced: false };
    const degrees = degreeMap(nodes, edges);
    const selected = [...nodes].sort((a, b) => {
      const ka = KIND_THEME[getNodeKind(a)]?.level ?? 4;
      const kb = KIND_THEME[getNodeKind(b)]?.level ?? 4;
      if (ka !== kb) return ka - kb;
      return (degrees.get(getNodeId(b)) || 0) - (degrees.get(getNodeId(a)) || 0);
    }).slice(0, maxNodes);
    const keep = new Set(selected.map(getNodeId));
    return { nodes: selected, edges: edges.filter(e => keep.has(safeString(e.source)) && keep.has(safeString(e.target))), sliced: true };
  }

  function nodeRadius(kind, degree, maxDegree, total) {
    const min = total > 2200 ? 15 : total > 900 ? 18 : 22;
    const max = total > 2200 ? 44 : total > 900 ? 54 : 72;
    const normalized = Math.log1p(Math.max(0, degree)) / Math.log1p(Math.max(1, maxDegree));
    const curved = Math.pow(clamp(normalized, 0, 1), 0.72);
    const boost = ({ System: 7, Incident: 7, Exception: 5, Layer: 3, Service: 1.5, Trace: 1, Database: 1, Middleware: .5, Queue: .5, API: 0, LogEvent: -3, Function: -1, Component: -1 })[kind] || 0;
    return clamp(min + curved * (max - min) + boost, min, max);
  }

  class GraphRenderer {
    constructor(canvas, elements) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.elements = elements;
      this.rawGraph = { nodes: [], edges: [], warnings: [] };
      this.nodes = [];
      this.edges = [];
      this.nodeById = new Map();
      this.offsetX = 0; this.offsetY = 0; this.scale = 1; this.dpr = 1;
      this.hover = null; this.selection = null; this.draggingView = false; this.draggingNode = null;
      this.lastPointer = { x: 0, y: 0 }; this.lastClick = { time: 0, id: '' }; this.needsDraw = true;
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas.parentElement);
      this.bindEvents(); this.resize(); this.animate();
    }
    setGraph(graph) {
      this.rawGraph = normalizeGraphPayload(graph);
      currentGraph = this.rawGraph;
      const visible = topologicalSlice(this.rawGraph, RENDER_LIMIT);
      this.prepare(visible); this.layout(); this.fit(false);
      this.elements.empty.classList.toggle('hidden', this.nodes.length > 0);
      this.selection = null; this.updateDetail(); this.requestDraw(); renderLegend(); refreshDatalists();
      return visible;
    }
    applyFilters() {
      const visible = topologicalSlice(this.rawGraph, RENDER_LIMIT);
      this.prepare(visible); this.layout(); this.fit(false);
      this.elements.empty.classList.toggle('hidden', this.nodes.length > 0);
      this.selection = null; this.updateDetail(); this.requestDraw();
      return visible;
    }
    prepare(graph) {
      const degrees = degreeMap(graph.nodes, graph.edges);
      const maxDegree = Math.max(1, ...degrees.values());
      const total = graph.nodes.length + graph.edges.length;
      const order = [...graph.nodes].sort((a, b) => (KIND_THEME[getNodeKind(a)]?.level ?? 4) - (KIND_THEME[getNodeKind(b)]?.level ?? 4));
      const kindCounts = new Map();
      this.nodes = order.map((node, index) => {
        const id = getNodeId(node) || `node-${index}`;
        const kind = getNodeKind(node);
        const theme = KIND_THEME[kind] || KIND_THEME.Component;
        const degree = degrees.get(id) || 0;
        const count = kindCounts.get(kind) || 0; kindCounts.set(kind, count + 1);
        return { id, raw: node, name: getNodeName(node), kind, degree, color: theme.color, border: theme.border, r: nodeRadius(kind, degree, maxDegree, total), level: theme.level, index, kindIndex: count, x: 0, y: 0, vx: 0, vy: 0 };
      });
      this.nodeById = new Map(this.nodes.map(n => [n.id, n]));
      this.edges = graph.edges.map((edge, index) => {
        const s = this.nodeById.get(safeString(edge.source));
        const t = this.nodeById.get(safeString(edge.target));
        if (!s || !t) return null;
        const type = getRelationType(edge);
        return { id: safeString(edge.id || edge.relation_id || `${edge.source}::${type}::${edge.target}::${index}`), raw: edge, source: s, target: t, type, color: relationColor(type), index };
      }).filter(Boolean);
    }
    layout() {
      const n = this.nodes.length; if (!n) return;
      const rings = new Map();
      for (const node of this.nodes) { const level = Math.min(6, Math.max(0, node.level || 0)); if (!rings.has(level)) rings.set(level, []); rings.get(level).push(node); }
      const base = n > 1000 ? 360 : n > 400 ? 300 : 240;
      for (const [level, list] of rings) {
        list.sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name, 'zh-CN'));
        const radius = level === 0 ? 0 : base * level + Math.sqrt(list.length) * 22;
        list.forEach((node, i) => {
          const angle = (Math.PI * 2 * i / Math.max(1, list.length)) + level * 0.55;
          const spiral = 1 + (i % 7) * 0.018;
          node.x = Math.cos(angle) * radius * spiral;
          node.y = Math.sin(angle) * radius * spiral;
        });
      }
      const iterations = n > 900 ? 80 : n > 350 ? 130 : 220;
      this.forceRelax(iterations);
    }
    forceRelax(iterations) {
      const nodes = this.nodes, edges = this.edges, n = nodes.length; if (n <= 1) return;
      const area = Math.max(900000, n * 11000); const k = Math.sqrt(area / n);
      for (let iter = 0; iter < iterations; iter++) {
        const cooling = 1 - iter / iterations;
        for (const node of nodes) { node.vx = 0; node.vy = 0; }
        const step = n > 900 ? 4 : 1;
        for (let i = 0; i < n; i += step) {
          const a = nodes[i];
          for (let j = i + step; j < n; j += step) {
            const b = nodes[j]; let dx = a.x - b.x; let dy = a.y - b.y; let d2 = dx * dx + dy * dy + 40; const d = Math.sqrt(d2);
            const minDist = a.r + b.r + 12; const force = Math.min(900, (k * k) / d2) * (d < minDist * 1.8 ? 2.1 : 1);
            dx /= d; dy /= d; a.vx += dx * force; a.vy += dy * force; b.vx -= dx * force; b.vy -= dy * force;
          }
        }
        for (const edge of edges) {
          const a = edge.source, b = edge.target; let dx = b.x - a.x; let dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const desired = 170 + (a.r + b.r) * 1.35; const force = (d - desired) * 0.018; dx /= d; dy /= d; a.vx += dx * force; a.vy += dy * force; b.vx -= dx * force; b.vy -= dy * force;
        }
        for (const node of nodes) { node.vx += -node.x * 0.0009; node.vy += -node.y * 0.0009; node.x += clamp(node.vx * cooling * 12, -28, 28); node.y += clamp(node.vy * cooling * 12, -28, 28); }
      }
    }
    bindEvents() {
      const canvas = this.canvas;
      canvas.addEventListener('wheel', e => {
        e.preventDefault(); const rect = canvas.getBoundingClientRect(); const px = e.clientX - rect.left; const py = e.clientY - rect.top; const before = this.screenToWorld(px, py);
        const factor = e.deltaY < 0 ? 1.12 : 0.89; this.scale = clamp(this.scale * factor, 0.12, 3.5); this.offsetX = px - before.x * this.scale; this.offsetY = py - before.y * this.scale; this.hideTooltip(); this.requestDraw();
      }, { passive: false });
      canvas.addEventListener('pointerdown', e => {
        canvas.setPointerCapture(e.pointerId); const p = this.eventPoint(e); const hit = this.hitNode(p.x, p.y); this.lastPointer = p; this.hideTooltip();
        if (hit && this.nodes.length < 1800) { this.draggingNode = hit; this.selection = { type: 'node', item: hit }; }
        else { this.draggingView = true; canvas.classList.add('dragging'); }
        this.requestDraw();
      });
      canvas.addEventListener('pointermove', e => {
        const p = this.eventPoint(e);
        if (this.draggingNode) { const w = this.screenToWorld(p.x, p.y); this.draggingNode.x = w.x; this.draggingNode.y = w.y; this.lastPointer = p; this.requestDraw(); return; }
        if (this.draggingView) { this.offsetX += p.x - this.lastPointer.x; this.offsetY += p.y - this.lastPointer.y; this.lastPointer = p; this.requestDraw(); return; }
        const node = this.hitNode(p.x, p.y); const edge = node ? null : this.hitEdge(p.x, p.y); const next = node ? { type: 'node', item: node, x: p.x, y: p.y } : edge ? { type: 'edge', item: edge, x: p.x, y: p.y } : null;
        if ((next?.item?.id || '') !== (this.hover?.item?.id || '') || (next?.type || '') !== (this.hover?.type || '')) { this.hover = next; this.updateTooltip(); this.requestDraw(); }
        else if (next) { this.hover.x = p.x; this.hover.y = p.y; this.updateTooltip(); }
      });
      canvas.addEventListener('pointerup', e => {
        const p = this.eventPoint(e); const wasNodeDrag = !!this.draggingNode; this.draggingNode = null; this.draggingView = false; canvas.classList.remove('dragging');
        const hit = this.hitNode(p.x, p.y); const edge = hit ? null : this.hitEdge(p.x, p.y);
        if (!wasNodeDrag || hit) {
          const now = Date.now();
          if (hit) { if (this.lastClick.id === hit.id && now - this.lastClick.time < 350) this.focusNode(hit); this.lastClick = { id: hit.id, time: now }; this.selection = { type: 'node', item: hit }; }
          else if (edge) { this.selection = { type: 'edge', item: edge }; }
          else { this.selection = null; }
          this.updateDetail();
        }
        this.requestDraw();
      });
      canvas.addEventListener('pointerleave', () => { this.hover = null; this.draggingNode = null; this.draggingView = false; canvas.classList.remove('dragging'); this.hideTooltip(); this.requestDraw(); });
    }
    resize() {
      const parent = this.canvas.parentElement; const rect = parent.getBoundingClientRect(); this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr)); this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr)); this.canvas.style.width = `${rect.width}px`; this.canvas.style.height = `${rect.height}px`; this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (this.nodes.length && (this.offsetX === 0 && this.offsetY === 0)) this.fit(false); this.requestDraw();
    }
    eventPoint(e) { const rect = this.canvas.getBoundingClientRect(); return { x: e.clientX - rect.left, y: e.clientY - rect.top }; }
    screenToWorld(x, y) { return { x: (x - this.offsetX) / this.scale, y: (y - this.offsetY) / this.scale }; }
    fit(animate = true) {
      if (!this.nodes.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of this.nodes) { minX = Math.min(minX, n.x - n.r); minY = Math.min(minY, n.y - n.r); maxX = Math.max(maxX, n.x + n.r); maxY = Math.max(maxY, n.y + n.r); }
      const rect = this.canvas.getBoundingClientRect(); const w = Math.max(1, maxX - minX); const h = Math.max(1, maxY - minY);
      const targetScale = clamp(Math.min((rect.width - 120) / w, (rect.height - 120) / h), 0.12, 1.4);
      const targetOffsetX = rect.width / 2 - ((minX + maxX) / 2) * targetScale; const targetOffsetY = rect.height / 2 - ((minY + maxY) / 2) * targetScale;
      if (!animate) { this.scale = targetScale; this.offsetX = targetOffsetX; this.offsetY = targetOffsetY; this.requestDraw(); return; }
      const start = { s: this.scale, x: this.offsetX, y: this.offsetY }; const startTime = performance.now(); const duration = 360;
      const tick = t => { const p = clamp((t - startTime) / duration, 0, 1); const eased = 1 - Math.pow(1 - p, 3); this.scale = start.s + (targetScale - start.s) * eased; this.offsetX = start.x + (targetOffsetX - start.x) * eased; this.offsetY = start.y + (targetOffsetY - start.y) * eased; this.requestDraw(); if (p < 1) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }
    focusNode(node) { const rect = this.canvas.getBoundingClientRect(); this.scale = clamp(1.15, 0.12, 3.5); this.offsetX = rect.width / 2 - node.x * this.scale; this.offsetY = rect.height / 2 - node.y * this.scale; this.requestDraw(); }
    requestDraw() { this.needsDraw = true; }
    animate() { if (this.needsDraw) { this.draw(); this.needsDraw = false; } requestAnimationFrame(() => this.animate()); }
    selectedNodeSet() { if (!this.selection || this.selection.type !== 'node') return null; const center = this.selection.item; const set = new Set([center.id]); for (const e of this.edges) { if (e.source.id === center.id) set.add(e.target.id); if (e.target.id === center.id) set.add(e.source.id); } return set; }
    draw() {
      const ctx = this.ctx; const rect = this.canvas.getBoundingClientRect(); ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height); this.drawBackground(ctx, rect.width, rect.height);
      ctx.save(); ctx.translate(this.offsetX, this.offsetY); ctx.scale(this.scale, this.scale); this.drawLayerBands(ctx); const selectedSet = this.selectedNodeSet(); for (const edge of this.edges) this.drawEdge(ctx, edge, selectedSet); for (const node of this.nodes) this.drawNode(ctx, node, selectedSet); ctx.restore();
    }
    drawBackground(ctx, w, h) {
      const step = 28; ctx.save(); ctx.fillStyle = '#eef3fb'; ctx.fillRect(0, 0, w, h); ctx.strokeStyle = 'rgba(148,163,184,.20)'; ctx.lineWidth = 1;
      const ox = ((this.offsetX % (step * this.scale)) + step * this.scale) % (step * this.scale); const oy = ((this.offsetY % (step * this.scale)) + step * this.scale) % (step * this.scale); const grid = Math.max(12, step * this.scale);
      for (let x = ox; x < w; x += grid) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = oy; y < h; y += grid) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); } ctx.restore();
    }
    drawLayerBands(ctx) {
      if (!this.nodes.length || this.nodes.length > 900) return;
      const levels = [...new Set(this.nodes.map(n => n.level))].sort((a, b) => a - b);
      ctx.save(); ctx.lineWidth = 1 / this.scale; ctx.setLineDash([8 / this.scale, 7 / this.scale]);
      for (const level of levels) {
        if (level === 0) continue;
        const inLevel = this.nodes.filter(n => n.level === level); if (!inLevel.length) continue;
        const radius = Math.max(...inLevel.map(n => Math.hypot(n.x, n.y) + n.r + 34));
        ctx.strokeStyle = 'rgba(100,116,139,.20)'; ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = 'rgba(51,65,85,.55)'; ctx.font = `${Math.max(11, 12 / this.scale)}px ${getComputedStyle(document.body).fontFamily}`; ctx.textAlign = 'center'; ctx.fillText(`L${level}`, 0, -radius); ctx.setLineDash([8 / this.scale, 7 / this.scale]);
      }
      ctx.restore();
    }
    drawEdge(ctx, edge, selectedSet) {
      const a = edge.source, b = edge.target; const dim = selectedSet && !(selectedSet.has(a.id) && selectedSet.has(b.id)); const selected = this.selection?.type === 'edge' && this.selection.item.id === edge.id;
      const dx = b.x - a.x, dy = b.y - a.y; const len = Math.sqrt(dx * dx + dy * dy) || 1; const nx = -dy / len, ny = dx / len; const curve = Math.min(38, len * 0.12) * ((edge.index % 2) ? 1 : -1);
      const sx = a.x + dx / len * (a.r + 2), sy = a.y + dy / len * (a.r + 2); const tx = b.x - dx / len * (b.r + 6), ty = b.y - dy / len * (b.r + 6); const cx = (sx + tx) / 2 + nx * curve, cy = (sy + ty) / 2 + ny * curve;
      ctx.save(); ctx.strokeStyle = dim ? 'rgba(148,163,184,.18)' : rgba(edge.color, selected ? .9 : .58); ctx.lineWidth = selected ? 2.6 / this.scale : Math.max(.75 / this.scale, dim ? .55 : 1.15); ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(cx, cy, tx, ty); ctx.stroke(); this.drawArrow(ctx, cx, cy, tx, ty, dim ? 'rgba(148,163,184,.22)' : rgba(edge.color, selected ? .95 : .72));
      if ((selected || (!selectedSet && this.scale > .45 && this.edges.length < 900)) && len > 70) { ctx.font = `${Math.max(10, 11 / this.scale)}px ${getComputedStyle(document.body).fontFamily}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; const text = shorten(edge.type, 18); const metrics = ctx.measureText(text); ctx.fillStyle = 'rgba(255,255,255,.84)'; const pad = 5 / this.scale; ctx.beginPath(); this.roundRect(ctx, cx - metrics.width / 2 - pad, cy - 9 / this.scale, metrics.width + pad * 2, 18 / this.scale, 9 / this.scale); ctx.fill(); ctx.fillStyle = selected ? '#0f172a' : '#334155'; ctx.fillText(text, cx, cy); }
      ctx.restore();
    }
    drawArrow(ctx, cx, cy, tx, ty, color) { const angle = Math.atan2(ty - cy, tx - cx); const size = Math.max(7, 10 / Math.sqrt(this.scale)); ctx.save(); ctx.translate(tx, ty); ctx.rotate(angle); ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-size, size * .48); ctx.lineTo(-size, -size * .48); ctx.closePath(); ctx.fill(); ctx.restore(); }
    drawNode(ctx, node, selectedSet) {
      const selected = this.selection?.type === 'node' && this.selection.item.id === node.id; const hover = this.hover?.type === 'node' && this.hover.item.id === node.id; const dim = selectedSet && !selectedSet.has(node.id);
      ctx.save(); if (!dim) { ctx.shadowColor = rgba(node.color, selected ? .45 : node.degree >= 5 ? .25 : .14); ctx.shadowBlur = selected ? 34 : node.degree >= 5 ? 22 : 12; ctx.shadowOffsetY = selected ? 0 : 5; }
      ctx.fillStyle = dim ? 'rgba(226,232,240,.66)' : node.color; ctx.strokeStyle = dim ? 'rgba(148,163,184,.38)' : selected || hover ? '#111827' : node.border; ctx.lineWidth = (selected ? 5 : node.degree >= 5 ? 3 : 2) / this.scale; ctx.beginPath(); ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (node.kind === 'LogEvent') { ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.6 / this.scale; ctx.beginPath(); ctx.moveTo(node.x - node.r * .35, node.y); ctx.lineTo(node.x + node.r * .35, node.y); ctx.stroke(); }
      ctx.shadowColor = 'transparent'; const showLabel = this.scale > .28 || node.r > 38 || selected || hover;
      if (showLabel) { const fontSize = clamp(node.r * .34, 10, 17) / Math.max(.82, Math.sqrt(this.scale)); ctx.font = `700 ${fontSize}px ${getComputedStyle(document.body).fontFamily}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = dim ? 'rgba(255,255,255,.50)' : '#ffffff'; const lines = this.wrapLabel(node.name.replace(/^LogEvent:/, '日志:'), node.r > 44 ? 7 : 6, 3); const lineHeight = fontSize * 1.08; lines.forEach((line, i) => ctx.fillText(line, node.x, node.y + (i - (lines.length - 1) / 2) * lineHeight)); }
      ctx.restore();
    }
    wrapLabel(text, charsPerLine, maxLines) { const s = safeString(text).trim(); const clipped = s.length > charsPerLine * maxLines ? `${s.slice(0, charsPerLine * maxLines - 1)}…` : s; const chars = [...clipped]; const lines = []; for (let i = 0; i < chars.length; i += charsPerLine) lines.push(chars.slice(i, i + charsPerLine).join('')); return lines.slice(0, maxLines); }
    roundRect(ctx, x, y, w, h, r) { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
    hitNode(sx, sy) { const p = this.screenToWorld(sx, sy); let best = null, bestD = Infinity; for (let i = this.nodes.length - 1; i >= 0; i--) { const n = this.nodes[i]; const d = Math.hypot(p.x - n.x, p.y - n.y); if (d <= n.r + Math.max(6, 8 / this.scale) && d < bestD) { best = n; bestD = d; } } return best; }
    hitEdge(sx, sy) { if (this.edges.length > 2500) return null; const p = this.screenToWorld(sx, sy); let best = null, bestD = Infinity; for (const e of this.edges) { const a = e.source, b = e.target; const dx = b.x - a.x, dy = b.y - a.y; const len = Math.sqrt(dx * dx + dy * dy) || 1; const nx = -dy / len, ny = dx / len; const curve = Math.min(38, len * 0.12) * ((e.index % 2) ? 1 : -1); const cx = (a.x + b.x) / 2 + nx * curve, cy = (a.y + b.y) / 2 + ny * curve; const d = this.distanceToQuadratic(p, a, { x: cx, y: cy }, b); if (d < bestD && d < Math.max(9, 12 / this.scale)) { best = e; bestD = d; } } return best; }
    distanceToQuadratic(p, a, c, b) { let min = Infinity; for (let i = 0; i <= 18; i++) { const t = i / 18; const x = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x; const y = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y; min = Math.min(min, Math.hypot(p.x - x, p.y - y)); } return min; }
    updateTooltip() {
      const el = this.elements.tooltip; if (!this.hover) { this.hideTooltip(); return; } const item = this.hover.item; const isNode = this.hover.type === 'node';
      if (isNode) { const meta = metaObject(item.raw.meta); el.innerHTML = `<div class="tooltip-title">${escapeHtml(item.name)}</div><div class="tooltip-row"><b>类型</b><span>${escapeHtml(item.kind)}</span></div><div class="tooltip-row"><b>度数</b><span>${item.degree}</span></div>${item.raw.layer ? `<div class="tooltip-row"><b>层级</b><span>${escapeHtml(item.raw.layer)}</span></div>` : ''}${meta.timestamp ? `<div class="tooltip-row"><b>时间</b><span>${escapeHtml(meta.timestamp)}</span></div>` : ''}${item.raw.description ? `<p>${escapeHtml(item.raw.description)}</p>` : ''}<small>${escapeHtml(item.id)}</small>`; }
      else { el.innerHTML = `<div class="tooltip-title">${escapeHtml(item.type)}</div><div class="tooltip-row"><b>From</b><span>${escapeHtml(item.source.id)}</span></div><div class="tooltip-row"><b>To</b><span>${escapeHtml(item.target.id)}</span></div>${item.raw.description ? `<p>${escapeHtml(item.raw.description)}</p>` : ''}`; }
      const stage = this.canvas.parentElement.getBoundingClientRect(); const w = 340; const x = clamp(this.hover.x + 16, 12, Math.max(12, stage.width - w - 12)); const y = clamp(this.hover.y + 16, 76, Math.max(76, stage.height - 245)); el.style.left = `${x}px`; el.style.top = `${y}px`; el.classList.remove('hidden');
    }
    hideTooltip() { this.elements.tooltip.classList.add('hidden'); }
    updateDetail() {
      const panel = this.elements.detail; if (!this.selection) { panel.classList.add('hidden'); return; }
      const isNode = this.selection.type === 'node'; const item = this.selection.item; const raw = item.raw || {}; const meta = metaObject(raw.meta);
      $('detailKind').textContent = isNode ? item.kind : item.type; $('detailTitle').textContent = isNode ? item.name : `${item.source.name} → ${item.target.name}`; $('detailDesc').textContent = raw.description || '暂无描述';
      const extra = isNode ? [`<dt>ID</dt><dd>${escapeHtml(item.id)}</dd>`, `<dt>度数</dt><dd>${item.degree}</dd>`, raw.layer ? `<dt>层级</dt><dd>${escapeHtml(raw.layer)}</dd>` : '', raw.source_file ? `<dt>来源</dt><dd>${escapeHtml(raw.source_file)}</dd>` : '', meta.timestamp ? `<dt>时间</dt><dd>${escapeHtml(meta.timestamp)}</dd>` : '', meta.trace_id ? `<dt>Trace</dt><dd>${escapeHtml(meta.trace_id)}</dd>` : '', meta.level ? `<dt>级别</dt><dd>${escapeHtml(meta.level)}</dd>` : '']
        : [`<dt>Source</dt><dd>${escapeHtml(item.source.id)}</dd>`, `<dt>Target</dt><dd>${escapeHtml(item.target.id)}</dd>`, `<dt>Type</dt><dd>${escapeHtml(item.type)}</dd>`];
      $('detailMeta').innerHTML = extra.filter(Boolean).join(''); panel.classList.remove('hidden');
    }
  }

  const elements = { canvas: $('graphCanvas'), empty: $('emptyState'), tooltip: $('tooltip'), detail: $('detailPanel'), statusText: $('statusText'), statusMeta: $('statusMeta'), pulse: $('statusPulse'), toast: $('toast'), fileInput: $('fileInput'), incidentInput: $('incidentInput'), logAnalyzeInput: $('logAnalyzeInput') };
  const renderer = new GraphRenderer(elements.canvas, elements);

  function setBusy(busy) {
    elements.pulse.classList.toggle('busy', !!busy);
    for (const id of ['uploadLabel', 'incidentLabel', 'logAnalyzeLabel']) $(id).classList.toggle('disabled', !!busy);
    for (const el of [elements.fileInput, elements.incidentInput, elements.logAnalyzeInput]) el.disabled = !!busy;
    for (const id of ['refreshBtn', 'fitBtn', 'clearBtn', 'addNodeBtn', 'addEdgeBtn']) $(id).disabled = !!busy;
  }
  function setStatus(text, meta = '') { elements.statusText.textContent = text; elements.statusMeta.textContent = meta || `最后更新 ${nowTime()}`; }
  function showToast(message) { elements.toast.textContent = message; elements.toast.classList.remove('hidden'); window.clearTimeout(showToast.timer); showToast.timer = window.setTimeout(() => elements.toast.classList.add('hidden'), 9000); }
  function renderLegend() {
    const counts = new Map();
    for (const n of currentGraph.nodes || []) counts.set(getNodeKind(n), (counts.get(getNodeKind(n)) || 0) + 1);
    const rows = Object.entries(KIND_THEME).filter(([kind]) => counts.has(kind) || ['System', 'Layer', 'Service', 'Database', 'Middleware', 'Queue', 'API', 'Incident', 'Trace', 'LogEvent', 'Exception'].includes(kind));
    $('legendPanel').innerHTML = `<h3>节点图例 / 筛选</h3>${rows.map(([kind, t]) => `<label class="legend-row" title="${escapeHtml(t.hint)}"><input type="checkbox" data-kind="${kind}" ${activeKinds.has(kind) ? 'checked' : ''}/><span><span class="legend-dot" style="background:${t.color}"></span> ${escapeHtml(t.label)} <small>${kind}</small></span><span class="legend-count">${counts.get(kind) || 0}</span></label>`).join('')}<div class="legend-hint">双击节点聚焦；选择节点会高亮一跳邻居。异常链路节点可与架构服务节点直接相连。</div>`;
    $('legendPanel').querySelectorAll('input[data-kind]').forEach(input => input.addEventListener('change', e => { const kind = e.target.dataset.kind; if (e.target.checked) activeKinds.add(kind); else activeKinds.delete(kind); const visible = renderer.applyFilters(); setStatus(`已筛选展示 ${visible.nodes.length} 个节点 / ${visible.edges.length} 条关系`); }));
  }
  function refreshDatalists() {
    $('nodeNameList').innerHTML = (currentGraph.nodes || []).map(n => `<option value="${escapeHtml(getNodeId(n))}"></option>`).join('');
    $('relationTypeList').innerHTML = RELATION_TYPES.map(t => `<option value="${t}"></option>`).join('');
    $('nodeKind').innerHTML = Object.keys(KIND_THEME).map(k => `<option value="${k}">${KIND_THEME[k].label} / ${k}</option>`).join('');
  }
  async function loadGraph() {
    setBusy(true); setStatus('正在刷新知识图谱...', '');
    try { const data = await fetchGraph(QUERY_LIMIT); const visible = renderer.setGraph(data); const sliceText = visible.sliced ? `，已展示核心 ${visible.nodes.length} 个节点` : ''; setStatus(data.nodes.length ? `已加载 ${data.nodes.length} 个节点 / ${data.edges.length} 条关系${sliceText}` : '当前图谱为空'); if (data.warnings?.length) showToast(data.warnings.join('；')); }
    catch (err) { setStatus('图谱读取失败'); showToast(err.message || String(err)); }
    finally { setBusy(false); }
  }
  async function handleImport(file) {
    if (!file) return; setBusy(true); setStatus(`正在导入架构文档 ${file.name}...`, '');
    try { const result = await importKnowledgeFile(file); const data = result.graph ? normalizeGraphPayload(result.graph) : await fetchGraph(QUERY_LIMIT); const visible = renderer.setGraph(data); setStatus(`架构导入完成：${data.nodes.length} 个节点 / ${data.edges.length} 条关系${visible.sliced ? `，展示核心 ${visible.nodes.length}` : ''}`); if (result.logs?.length) showToast(result.logs.slice(-3).join('；')); }
    catch (err) { setStatus('架构导入失败'); showToast(err.message || String(err)); }
    finally { setBusy(false); elements.fileInput.value = ''; }
  }
  async function handleIncidentImport(file) {
    if (!file) return; setBusy(true); setStatus(`正在导入异常链路 ${file.name}...`, '');
    try { const result = await importIncidentFile(file); const data = result.graph ? normalizeGraphPayload(result.graph) : await fetchGraph(QUERY_LIMIT); renderer.setGraph(data); setStatus(`异常链路导入完成：新增/更新 ${result.nodes_written || 0} 个节点，${result.edges_written || 0} 条关系`); if (result.logs?.length) showToast(result.logs.slice(-4).join('；')); }
    catch (err) { setStatus('异常链路导入失败'); showToast(err.message || String(err)); }
    finally { setBusy(false); elements.incidentInput.value = ''; }
  }
  async function handleLogAnalyze(file) {
    if (!file) return; setBusy(true); setStatus(`正在运行滑动窗口日志分析 ${file.name}...`, '');
    try { const result = await analyzeLogsFile(file); const data = result.graph ? normalizeGraphPayload(result.graph) : await fetchGraph(QUERY_LIMIT); renderer.setGraph(data); const summary = result.summary || {}; setStatus(`日志分析完成：${summary.incidents ?? 0} 个故障，${summary.anomaly_windows ?? 0} 个异常窗口`); if (result.incident_import?.logs?.length) showToast(result.incident_import.logs.slice(-4).join('；')); }
    catch (err) { setStatus('日志分析失败'); showToast(err.message || String(err)); }
    finally { setBusy(false); elements.logAnalyzeInput.value = ''; }
  }
  async function handleClear() {
    if (!window.confirm('确定清空当前 LogSys 图谱？')) return; setBusy(true); setStatus('正在清空图谱...', '');
    try { await clearKnowledgeGraph(); renderer.setGraph({ nodes: [], edges: [], warnings: [] }); $('detailPanel').classList.add('hidden'); setStatus('图谱已清空'); }
    catch (err) { setStatus('清空失败'); showToast(err.message || String(err)); }
    finally { setBusy(false); }
  }

  function openNodeModal(item = null) {
    modalState = { type: 'node', mode: item ? 'edit' : 'create', item, originalName: item?.id || '' };
    refreshDatalists(); $('modalTitle').textContent = item ? '编辑节点' : '新增节点'; $('nodeFields').classList.remove('hidden'); $('edgeFields').classList.add('hidden');
    const raw = item?.raw || {}; $('nodeName').value = raw.name || item?.name || ''; $('nodeName').disabled = !!item; $('nodeKind').value = getNodeKind(raw || item || {}); $('nodeLayer').value = raw.layer || defaultLayer($('nodeKind').value); $('nodeSource').value = raw.source_file || 'manual'; $('nodeDesc').value = raw.description || ''; $('nodeMeta').value = JSON.stringify(metaObject(raw.meta), null, 2); $('editModal').classList.remove('hidden'); $('nodeName').focus();
  }
  function openEdgeModal(item = null) {
    modalState = { type: 'edge', mode: item ? 'edit' : 'create', item, originalName: '' };
    refreshDatalists(); $('modalTitle').textContent = item ? '编辑关系（保存会新增/覆盖同名关系）' : '新增关系'; $('edgeFields').classList.remove('hidden'); $('nodeFields').classList.add('hidden');
    $('edgeSource').value = item?.source?.id || ''; $('edgeTarget').value = item?.target?.id || ''; $('edgeType').value = item?.type || 'CALLS'; $('edgeDesc').value = item?.raw?.description || ''; $('edgeMeta').value = JSON.stringify(metaObject(item?.raw?.meta), null, 2); $('editModal').classList.remove('hidden'); $('edgeSource').focus();
  }
  function closeModal() { $('editModal').classList.add('hidden'); }
  function defaultLayer(kind) { return ({ System: '系统层', Layer: '系统层', Service: '业务服务层', API: '网关层', Database: '数据层', Middleware: '中间件层', Queue: '中间件层', Function: '功能层', Incident: '异常分析层', Trace: '异常分析层', LogEvent: '异常分析层', Exception: '异常分析层', Window: '异常分析层' })[kind] || 'Component层'; }
  async function handleModalSave() {
    setBusy(true);
    try {
      if (modalState.type === 'node') {
        const payload = { name: $('nodeName').value.trim(), kind: $('nodeKind').value, layer: $('nodeLayer').value.trim() || defaultLayer($('nodeKind').value), source_file: $('nodeSource').value.trim() || 'manual', description: $('nodeDesc').value.trim(), meta: parseMetaInput($('nodeMeta').value) };
        if (!payload.name) throw new Error('节点名称不能为空');
        const result = await saveNode(payload, modalState.mode === 'edit' ? modalState.originalName : '');
        renderer.setGraph(normalizeGraphPayload(result.graph)); setStatus(modalState.mode === 'edit' ? '节点已更新' : '节点已新增');
      } else {
        const payload = { source: $('edgeSource').value.trim(), target: $('edgeTarget').value.trim(), type: $('edgeType').value.trim().toUpperCase() || 'CALLS', description: $('edgeDesc').value.trim(), meta: parseMetaInput($('edgeMeta').value) };
        if (!payload.source || !payload.target) throw new Error('关系起点和终点不能为空');
        const result = await saveEdge(payload); renderer.setGraph(normalizeGraphPayload(result.graph)); setStatus('关系已保存');
      }
      closeModal();
    } catch (err) { showToast(err.message || String(err)); }
    finally { setBusy(false); }
  }
  async function handleDeleteSelected() {
    if (!renderer.selection) return;
    const sel = renderer.selection;
    const label = sel.type === 'node' ? sel.item.name : `${sel.item.source.name} → ${sel.item.target.name}`;
    if (!window.confirm(`确定删除 ${label}？`)) return;
    setBusy(true);
    try {
      const result = sel.type === 'node' ? await deleteNode(sel.item.id) : await deleteEdge(sel.item);
      renderer.setGraph(normalizeGraphPayload(result.graph)); setStatus(result.deleted ? '删除完成' : '没有找到要删除的对象');
    } catch (err) { showToast(err.message || String(err)); }
    finally { setBusy(false); }
  }

  elements.fileInput.addEventListener('change', e => handleImport(e.target.files && e.target.files[0]));
  elements.incidentInput.addEventListener('change', e => handleIncidentImport(e.target.files && e.target.files[0]));
  elements.logAnalyzeInput.addEventListener('change', e => handleLogAnalyze(e.target.files && e.target.files[0]));
  $('refreshBtn').addEventListener('click', loadGraph); $('fitBtn').addEventListener('click', () => renderer.fit(true)); $('clearBtn').addEventListener('click', handleClear);
  $('addNodeBtn').addEventListener('click', () => openNodeModal()); $('addEdgeBtn').addEventListener('click', () => openEdgeModal());
  $('detailClose').addEventListener('click', () => { renderer.selection = null; renderer.updateDetail(); renderer.requestDraw(); });
  $('editSelectedBtn').addEventListener('click', () => { if (!renderer.selection) return; renderer.selection.type === 'node' ? openNodeModal(renderer.selection.item) : openEdgeModal(renderer.selection.item); });
  $('deleteSelectedBtn').addEventListener('click', handleDeleteSelected);
  $('modalClose').addEventListener('click', closeModal); $('modalCancel').addEventListener('click', closeModal); $('modalSave').addEventListener('click', handleModalSave);
  $('nodeKind').addEventListener('change', () => { if (!$('nodeLayer').value.trim()) $('nodeLayer').value = defaultLayer($('nodeKind').value); });
  window.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  renderLegend(); refreshDatalists(); loadGraph();
})();
