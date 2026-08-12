import { axisBottom, axisLeft, max, scaleBand, scaleLinear, select } from "d3";

const COLORS = {
  root: "#3157d5",
  chain: "#79a7bc",
  mode: "#2c7d85",
  path: "#7562b8",
  grid: "#e6eaf1",
  text: "#5d6980",
};

export function buildReportChartModel(report = {}) {
  return {
    nodes: (report.node_frequencies || []).slice(0, 10).map((item) => ({
      name: item.node || "未命名节点",
      rootHits: Number(item.root_hits || 0),
      chainHits: Number(item.chain_hits || 0),
      incidentCount: Number(item.incident_count || 0),
    })),
    modes: (report.fault_modes || []).slice(0, 8).map((item) => ({
      name: item.label || "未分类故障",
      count: Number(item.count || 0),
      ratio: Number(item.ratio || 0),
    })),
    paths: (report.propagation_paths || []).slice(0, 8).map((item) => ({
      nodes: Array.isArray(item.path) ? item.path : [],
      label: item.path_label || (item.path || []).join(" → "),
      count: Number(item.count || 0),
      ratio: Number(item.ratio || 0),
      incidentIds: item.incident_ids || [],
    })),
  };
}

export function renderReportCharts(elements, report, options = {}) {
  const model = buildReportChartModel(report);
  renderNodeFrequency(elements.nodeFrequency, model.nodes);
  renderFaultModes(elements.faultModes, model.modes);
  renderPropagationPaths(elements.propagationPaths, model.paths, options.onPathClick);
}

function prepareSvg(element, width, height, emptyMessage) {
  if (!element) return null;
  element.replaceChildren();
  if (height === 0) {
    const empty = document.createElement("div");
    empty.className = "report-chart-empty";
    empty.textContent = emptyMessage;
    element.append(empty);
    return null;
  }
  return select(element)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("role", "img")
    .attr("aria-label", emptyMessage.replace("暂无", ""));
}

function renderNodeFrequency(element, data) {
  const width = 860;
  const margin = { top: 18, right: 58, bottom: 36, left: 150 };
  const rowHeight = 38;
  const height = data.length ? margin.top + margin.bottom + data.length * rowHeight : 0;
  const svg = prepareSvg(element, width, height, "暂无节点故障频次数据");
  if (!svg) return;
  const chartWidth = width - margin.left - margin.right;
  const y = scaleBand().domain(data.map((item) => item.name)).range([margin.top, height - margin.bottom]).padding(0.26);
  const x = scaleLinear()
    .domain([0, max(data, (item) => Math.max(item.rootHits, item.chainHits)) || 1])
    .nice()
    .range([margin.left, width - margin.right]);

  svg.append("g")
    .attr("class", "report-chart-grid")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(axisBottom(x).ticks(5).tickSize(-(height - margin.top - margin.bottom)).tickFormat((value) => String(value)))
    .call((group) => group.select(".domain").remove());
  svg.append("g")
    .attr("class", "report-chart-axis")
    .attr("transform", `translate(${margin.left},0)`)
    .call(axisLeft(y).tickSize(0))
    .call((group) => group.select(".domain").remove());

  const half = y.bandwidth() / 2;
  svg.selectAll(".report-root-bar")
    .data(data)
    .join("rect")
    .attr("class", "report-root-bar")
    .attr("x", margin.left)
    .attr("y", (item) => y(item.name))
    .attr("width", (item) => Math.max(0, x(item.rootHits) - margin.left))
    .attr("height", Math.max(5, half - 2))
    .attr("rx", 3)
    .attr("fill", COLORS.root);
  svg.selectAll(".report-chain-bar")
    .data(data)
    .join("rect")
    .attr("class", "report-chain-bar")
    .attr("x", margin.left)
    .attr("y", (item) => y(item.name) + half + 2)
    .attr("width", (item) => Math.max(0, x(item.chainHits) - margin.left))
    .attr("height", Math.max(5, half - 2))
    .attr("rx", 3)
    .attr("fill", COLORS.chain);
  svg.selectAll(".report-node-value")
    .data(data)
    .join("text")
    .attr("class", "report-chart-value")
    .attr("x", (item) => Math.max(x(item.rootHits), x(item.chainHits)) + 7)
    .attr("y", (item) => y(item.name) + y.bandwidth() / 2 + 4)
    .text((item) => `${item.incidentCount} 个故障`);
}

function renderFaultModes(element, data) {
  const width = 620;
  const margin = { top: 16, right: 72, bottom: 28, left: 145 };
  const height = data.length ? margin.top + margin.bottom + data.length * 42 : 0;
  const svg = prepareSvg(element, width, height, "暂无故障模式分布数据");
  if (!svg) return;
  const y = scaleBand().domain(data.map((item) => item.name)).range([margin.top, height - margin.bottom]).padding(0.38);
  const x = scaleLinear().domain([0, max(data, (item) => item.count) || 1]).nice().range([margin.left, width - margin.right]);
  svg.append("g").attr("class", "report-chart-axis").attr("transform", `translate(${margin.left},0)`).call(axisLeft(y).tickSize(0)).call((group) => group.select(".domain").remove());
  svg.selectAll(".report-mode-track").data(data).join("rect")
    .attr("x", margin.left).attr("y", (item) => y(item.name)).attr("width", width - margin.left - margin.right)
    .attr("height", y.bandwidth()).attr("rx", 5).attr("fill", "#eef1f5");
  svg.selectAll(".report-mode-bar").data(data).join("rect")
    .attr("x", margin.left).attr("y", (item) => y(item.name)).attr("width", (item) => x(item.count) - margin.left)
    .attr("height", y.bandwidth()).attr("rx", 5).attr("fill", COLORS.mode);
  svg.selectAll(".report-mode-value").data(data).join("text")
    .attr("class", "report-chart-value").attr("x", width - margin.right + 8)
    .attr("y", (item) => y(item.name) + y.bandwidth() / 2 + 4).text((item) => `${item.count} · ${Math.round(item.ratio * 100)}%`);
}

function renderPropagationPaths(element, data, onClick) {
  const width = 860;
  const rowHeight = 64;
  const height = data.length ? data.length * rowHeight + 12 : 0;
  const svg = prepareSvg(element, width, height, "暂无高频故障传播路径数据");
  if (!svg) return;
  const maxCount = max(data, (item) => item.count) || 1;
  const rows = svg.selectAll(".report-path-row").data(data).join("g")
    .attr("class", "report-path-row")
    .attr("transform", (_item, index) => `translate(0,${index * rowHeight + 6})`)
    .attr("tabindex", onClick ? 0 : null)
    .attr("role", onClick ? "button" : null)
    .on("click", (_event, item) => onClick?.(item))
    .on("keydown", (event, item) => { if (event.key === "Enter" || event.key === " ") onClick?.(item); });
  rows.append("rect").attr("x", 0).attr("y", 0).attr("width", width).attr("height", 52).attr("rx", 8).attr("fill", "#f8f9fc");
  rows.append("rect").attr("x", 0).attr("y", 0).attr("width", (item) => 5 + 105 * item.count / maxCount).attr("height", 52).attr("rx", 8).attr("fill", "#ebe8f7");
  rows.append("text").attr("class", "report-path-rank").attr("x", 17).attr("y", 31).text((_item, index) => String(index + 1).padStart(2, "0"));
  rows.append("text").attr("class", "report-path-label").attr("x", 68).attr("y", 25).text((item) => truncate(item.label, 72));
  rows.append("text").attr("class", "report-path-meta").attr("x", 68).attr("y", 42).text((item) => `${item.nodes.length} 个节点 · 占本批次 ${Math.round(item.ratio * 100)}%`);
  rows.append("text").attr("class", "report-path-count").attr("x", width - 22).attr("y", 31).attr("text-anchor", "end").text((item) => `${item.count} 次`);
}

function truncate(value, length) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
