import test from "node:test";
import assert from "node:assert/strict";

import { buildIncidentSemantics, filterIncidentGraph } from "../js/graph-semantics.js";

const hypotheses = [
  {
    rank: 1,
    candidate: "mysql-1",
    chain: ["mysql-1", "order-service", "gateway"],
  },
  {
    rank: 2,
    candidate: "redis-2",
    chain: ["redis-2", "auth-service", "gateway"],
  },
];

test("matches a real LLM decision by candidate name", () => {
  const result = buildIncidentSemantics(hypotheses, {
    source: "llm",
    selected_candidate: " Redis-2 ",
    selected_candidate_rank: 2,
  });

  assert.equal(result.primary.source, "llm");
  assert.equal(result.primary.rank, 2);
  assert.deepEqual(result.primary.chain, ["redis-2", "auth-service", "gateway"]);
  assert.equal(result.start, "redis-2");
  assert.equal(result.end, "gateway");
});

test("uses the top ranked hypothesis as an algorithm fallback", () => {
  const result = buildIncidentSemantics(hypotheses, {
    source: "fallback",
    selected_candidate: "redis-2",
  });

  assert.equal(result.primary.source, "algorithm");
  assert.equal(result.primary.rank, 1);
  assert.deepEqual(result.primary.chain, ["mysql-1", "order-service", "gateway"]);
});

test("filters evidence nodes and their dangling edges from the default graph", () => {
  const graph = {
    nodes: [
      { name: "Incident:x", kind: "Incident" },
      { name: "Hypothesis:x", kind: "RCAHypothesis" },
      { name: "Trace:x", kind: "Trace" },
      { name: "Exception:x", kind: "Exception" },
      { name: "LogEvent:x", kind: "LogEvent" },
      { name: "redis-2", kind: "Instance" },
    ],
    edges: [
      { source: "Incident:x", target: "Trace:x", type: "HAS_TRACE" },
      { source: "Incident:x", target: "LogEvent:x", type: "HAS_EVENT" },
      { source: "Hypothesis:x", target: "redis-2", type: "CANDIDATE_CAUSE" },
    ],
    warnings: ["source warning"],
  };

  const filtered = filterIncidentGraph(graph, false);
  assert.deepEqual(filtered.nodes.map((node) => node.name), ["Incident:x", "Hypothesis:x", "redis-2"]);
  assert.deepEqual(filtered.edges.map((edge) => edge.type), ["CANDIDATE_CAUSE"]);
  assert.deepEqual(filtered.warnings, ["source warning"]);
  assert.equal(filterIncidentGraph(graph, true), graph);
});

test("builds model and alternative propagation overlays in chain order", () => {
  const result = buildIncidentSemantics(hypotheses, {
    source: "llm",
    selected_candidate: "redis-2",
  });

  assert.deepEqual(
    result.overlays.map(({ source, target, variant, rank }) => ({ source, target, variant, rank })),
    [
      { source: "redis-2", target: "auth-service", variant: "model", rank: 2 },
      { source: "auth-service", target: "gateway", variant: "model", rank: 2 },
      { source: "mysql-1", target: "order-service", variant: "alternative", rank: 1 },
      { source: "order-service", target: "gateway", variant: "alternative", rank: 1 },
    ],
  );
  assert.deepEqual(result.candidateRanks, { "mysql-1": 1, "redis-2": 2 });
});

test("uses algorithm styling for fallback overlays", () => {
  const result = buildIncidentSemantics(hypotheses, { source: "fallback" });
  assert.deepEqual(result.overlays.slice(0, 2).map((edge) => edge.variant), ["algorithm", "algorithm"]);
});

test("matches a model decision by rank when its candidate name is unknown", () => {
  const result = buildIncidentSemantics(hypotheses, {
    source: "llm",
    selected_candidate: "unknown",
    selected_candidate_rank: 2,
  });
  assert.equal(result.primary.candidate, "redis-2");
  assert.equal(result.primary.source, "llm");
});

test("reports missing chain nodes without inventing propagation segments", () => {
  const visibleNames = new Set(["redis-2", "gateway", "mysql-1", "order-service"]);
  const result = buildIncidentSemantics(hypotheses, {
    source: "llm",
    selected_candidate: "redis-2",
  }, visibleNames);

  assert.deepEqual(result.overlays.filter((edge) => edge.variant === "model"), []);
  assert.match(result.warnings[0], /auth-service/);
  assert.equal(result.start, "redis-2");
  assert.equal(result.end, "gateway");
});
