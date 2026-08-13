import assert from "node:assert/strict";
import test from "node:test";

import { buildReportChartModel } from "../src/js/report-charts.js";

test("report chart model keeps root and propagation counts as separate measures", () => {
  const model = buildReportChartModel({
    node_frequencies: [
      { node: "redis-2", root_hits: 3, chain_hits: 5, incident_count: 4 },
    ],
    fault_modes: [
      { label: "Redis 访问超时", count: 3, ratio: 0.75 },
    ],
    propagation_paths: [
      { path: ["redis-2", "api-gateway"], count: 2, ratio: 0.5, incident_ids: ["I-1"] },
    ],
  });

  assert.deepEqual(model.nodes[0], {
    name: "redis-2",
    rootHits: 3,
    chainHits: 5,
    incidentCount: 4,
  });
  assert.deepEqual(model.modes[0], {
    name: "Redis 访问超时",
    count: 3,
    ratio: 0.75,
  });
  assert.equal(model.paths[0].label, "redis-2 → api-gateway");
  assert.deepEqual(model.paths[0].incidentIds, ["I-1"]);
});

test("report chart model limits charts to readable ranked sets", () => {
  const report = {
    node_frequencies: Array.from({ length: 15 }, (_value, index) => ({ node: `node-${index}` })),
    fault_modes: Array.from({ length: 11 }, (_value, index) => ({ label: `mode-${index}` })),
    propagation_paths: Array.from({ length: 12 }, (_value, index) => ({ path: [`node-${index}`] })),
  };

  const model = buildReportChartModel(report);
  assert.equal(model.nodes.length, 10);
  assert.equal(model.modes.length, 8);
  assert.equal(model.paths.length, 8);
});
