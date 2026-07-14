export const KIND_THEME = {
  System: { label: 'System', color: '#2563eb', border: '#1d4ed8', soft: '#dbeafe', level: 0 },
  Layer: { label: 'Layer', color: '#7c3aed', border: '#6d28d9', soft: '#ede9fe', level: 1 },
  Service: { label: 'Service', color: '#0891b2', border: '#0e7490', soft: '#cffafe', level: 2 },
  Database: { label: 'Database', color: '#16a34a', border: '#15803d', soft: '#dcfce7', level: 3 },
  Middleware: { label: 'Middleware', color: '#ea580c', border: '#c2410c', soft: '#ffedd5', level: 3 },
  Queue: { label: 'Queue', color: '#ca8a04', border: '#a16207', soft: '#fef3c7', level: 3 },
  API: { label: 'API', color: '#db2777', border: '#be185d', soft: '#fce7f3', level: 2 },
  Function: { label: 'Function', color: '#475569', border: '#334155', soft: '#e2e8f0', level: 4 },
  Component: { label: 'Component', color: '#64748b', border: '#475569', soft: '#f1f5f9', level: 4 }
};

const KIND_ALIASES = new Map([
  ['system', 'System'], ['系统', 'System'], ['应用系统', 'System'], ['平台', 'System'],
  ['layer', 'Layer'], ['层', 'Layer'], ['层级', 'Layer'], ['架构层', 'Layer'],
  ['service', 'Service'], ['服务', 'Service'], ['微服务', 'Service'], ['应用服务', 'Service'], ['application', 'Service'], ['app', 'Service'],
  ['database', 'Database'], ['db', 'Database'], ['数据库', 'Database'], ['数据存储', 'Database'], ['mysql', 'Database'], ['postgresql', 'Database'], ['postgres', 'Database'], ['oracle', 'Database'], ['mongodb', 'Database'], ['redis-db', 'Database'],
  ['middleware', 'Middleware'], ['中间件', 'Middleware'], ['redis', 'Middleware'], ['cache', 'Middleware'], ['缓存', 'Middleware'], ['elasticsearch', 'Middleware'], ['es', 'Middleware'], ['nginx', 'Middleware'],
  ['queue', 'Queue'], ['mq', 'Queue'], ['消息队列', 'Queue'], ['kafka', 'Queue'], ['rabbitmq', 'Queue'], ['rocketmq', 'Queue'], ['pulsar', 'Queue'],
  ['api', 'API'], ['接口', 'API'], ['gateway api', 'API'], ['rest api', 'API'], ['http api', 'API'],
  ['function', 'Function'], ['功能', 'Function'], ['用例', 'Function'], ['能力', 'Function'],
  ['component', 'Component'], ['组件', 'Component'], ['模块', 'Component'], ['module', 'Component']
]);

export const RELATION_THEME = {
  CALLS: '#2563eb',
  USES_DB: '#16a34a',
  CONTAINS: '#7c3aed',
  BELONGS_TO_LAYER: '#8b5cf6',
  PROVIDES: '#db2777',
  DEPENDS_ON: '#ea580c',
  READS: '#0d9488',
  WRITES: '#059669',
  PUBLISHES: '#ca8a04',
  SUBSCRIBES: '#9333ea',
  RELATION: '#64748b'
};

export function safeString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

export function getNodeId(node) {
  return safeString(node?.id || node?.uid || node?.name);
}

export function getNodeName(node) {
  return safeString(node?.name || node?.label || node?.id || node?.uid || '未命名节点');
}

export function normalizeKind(value) {
  const raw = safeString(value || 'Component').trim();
  if (KIND_THEME[raw]) return raw;
  const compact = raw.toLowerCase().replace(/[\s_]+/g, ' ').trim();
  if (KIND_ALIASES.has(compact)) return KIND_ALIASES.get(compact);
  const noSpace = compact.replace(/[-\s]/g, '');
  if (KIND_ALIASES.has(noSpace)) return KIND_ALIASES.get(noSpace);

  // 容错：大模型偶尔会把具体技术名放进 kind，这里把它归并到稳定类别，保证同类同色。
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

export function getNodeKind(node) {
  return normalizeKind(node?.kind || node?.type || 'Component');
}

export function getRelationType(edge) {
  return safeString(edge?.type || edge?.relation_type || edge?.label || 'RELATION');
}

export function degreeMap(nodes, edges) {
  const ids = new Set(nodes.map(getNodeId));
  const degree = new Map(nodes.map(node => [getNodeId(node), 0]));
  for (const edge of edges) {
    const source = safeString(edge.source);
    const target = safeString(edge.target);
    if (ids.has(source)) degree.set(source, (degree.get(source) || 0) + 1);
    if (ids.has(target)) degree.set(target, (degree.get(target) || 0) + 1);
  }
  return degree;
}

export function shortenLabel(label, max = 18) {
  const text = safeString(label).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function wrapLabel(label, lineLength = 8, maxLength = 24) {
  const text = safeString(label).trim();
  const clipped = text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  const chars = [...clipped];
  const lines = [];
  for (let i = 0; i < chars.length; i += lineLength) {
    lines.push(chars.slice(i, i + lineLength).join(''));
  }
  return lines.slice(0, 3).join('\n');
}

export function escapeHtml(value) {
  return safeString(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function relationColor(type) {
  return RELATION_THEME[type] || RELATION_THEME.RELATION;
}

export function rgba(hex, alpha) {
  const value = hex.replace('#', '');
  const normalized = value.length === 3 ? value.split('').map(ch => ch + ch).join('') : value;
  const number = Number.parseInt(normalized, 16);
  if (Number.isNaN(number)) return `rgba(100,116,139,${alpha})`;
  const r = (number >> 16) & 255;
  const g = (number >> 8) & 255;
  const b = number & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function connectedNodeIds(nodeId, edges) {
  const center = safeString(nodeId);
  const ids = new Set(center ? [center] : []);
  if (!center) return ids;
  for (const edge of edges) {
    const source = safeString(edge.source);
    const target = safeString(edge.target);
    if (source === center) ids.add(target);
    if (target === center) ids.add(source);
  }
  return ids;
}

export function topologicalSlice(graph, maxNodes = 1000) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  if (nodes.length <= maxNodes) return { nodes, edges, sliced: false };

  const degree = degreeMap(nodes, edges);
  const selected = [...nodes]
    .sort((a, b) => {
      const kindA = KIND_THEME[getNodeKind(a)]?.level ?? 4;
      const kindB = KIND_THEME[getNodeKind(b)]?.level ?? 4;
      if (kindA !== kindB) return kindA - kindB;
      return (degree.get(getNodeId(b)) || 0) - (degree.get(getNodeId(a)) || 0);
    })
    .slice(0, maxNodes);
  const keep = new Set(selected.map(getNodeId));
  return {
    nodes: selected,
    edges: edges.filter(edge => keep.has(safeString(edge.source)) && keep.has(safeString(edge.target))),
    sliced: true
  };
}
