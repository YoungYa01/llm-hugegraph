import test from "node:test";
import assert from "node:assert/strict";

import { createForceLayout } from "../js/graph-layout.js";

const nodes = ["root", "service", "gateway"].map((name) => ({ name }));
const edges = [
  { source: "root", target: "service" },
  { source: "service", target: "gateway" },
];

test("uses deterministic initial coordinates", () => {
  const first = createForceLayout(nodes, edges).snapshot();
  const second = createForceLayout(nodes, edges).snapshot();

  assert.deepEqual(first, second);
});

test("keeps a pinned node at its dragged position", () => {
  const layout = createForceLayout(nodes, edges);
  layout.pin("service", 420, 180);
  layout.settle(80);

  assert.deepEqual(layout.position("service"), { x: 420, y: 180 });
});

test("biases the incident propagation chain from left to right", () => {
  const outOfOrderNodes = ["gateway", "service", "root"].map((name) => ({ name }));
  const layout = createForceLayout(outOfOrderNodes, edges, {
    mode: "incident",
    primaryChain: ["root", "service", "gateway"],
  });
  layout.settle(220);

  assert.ok(layout.position("root").x < layout.position("service").x);
  assert.ok(layout.position("service").x < layout.position("gateway").x);
});

test("separates overlapping nodes with collision forces", () => {
  const crowdedNodes = Array.from({ length: 24 }, (_, index) => ({ name: `node-${index}` }));
  const layout = createForceLayout(crowdedNodes, [], { nodeRadius: 24 });
  layout.settle(220);
  const positions = layout.snapshot();
  let minimumDistance = Infinity;
  for (let left = 0; left < positions.length; left += 1) {
    for (let right = left + 1; right < positions.length; right += 1) {
      minimumDistance = Math.min(
        minimumDistance,
        Math.hypot(
          positions[left].x - positions[right].x,
          positions[left].y - positions[right].y,
        ),
      );
    }
  }

  assert.ok(minimumDistance >= 51, `minimum distance was ${minimumDistance}`);
});

test("pulls connected nodes toward the relationship distance", () => {
  const linkedNodes = [{ name: "candidate-18" }, { name: "candidate-40" }];
  const layout = createForceLayout(linkedNodes, [
    { source: "candidate-18", target: "candidate-40" },
  ]);
  layout.settle(220);
  const source = layout.position("candidate-18");
  const target = layout.position("candidate-40");
  const distance = Math.hypot(source.x - target.x, source.y - target.y);

  assert.ok(distance < 190, `relationship distance was ${distance}`);
  assert.ok(distance > 50, `relationship distance was ${distance}`);
});

test("recovers from non-finite dragged coordinates", () => {
  const layout = createForceLayout(nodes, edges);
  layout.pin("service", Number.NaN, Number.POSITIVE_INFINITY);
  layout.step();
  const position = layout.position("service");

  assert.equal(Number.isFinite(position.x), true);
  assert.equal(Number.isFinite(position.y), true);
});

test("clears pinned positions before relayout", () => {
  const layout = createForceLayout(nodes, edges, {
    mode: "incident",
    primaryChain: ["root", "service", "gateway"],
  });
  layout.pin("root", 900, 500);
  layout.settle(40);
  assert.deepEqual(layout.position("root"), { x: 900, y: 500 });

  layout.clearPins();
  layout.reheat();
  layout.settle(220);
  assert.ok(layout.position("root").x < 300);
});

test("resets dragged coordinates before relayout", () => {
  const layout = createForceLayout([{ name: "isolated" }], []);
  const initial = layout.position("isolated");
  layout.pin("isolated", 5000, 5000);

  layout.reset();

  assert.deepEqual(layout.position("isolated"), initial);
});

test("settles when overlapping nodes are both pinned", () => {
  const layout = createForceLayout([{ name: "left" }, { name: "right" }], []);
  layout.pin("left", 240, 240);
  layout.pin("right", 240, 240);
  let settled = false;

  for (let index = 0; index < 300 && !settled; index += 1) {
    settled = layout.step();
  }

  assert.equal(settled, true);
});

test("keeps non-chain nodes outside the primary propagation corridor", () => {
  const incidentNodes = ["root", "service", "gateway", "extra-0"].map((name) => ({ name }));
  const incidentEdges = [
    ...edges,
    { source: "extra-0", target: "service" },
  ];
  const layout = createForceLayout(incidentNodes, incidentEdges, {
    mode: "incident",
    primaryChain: ["root", "service", "gateway"],
  });
  layout.settle(220);
  const chainY = ["root", "service", "gateway"]
    .map((name) => layout.position(name).y)
    .reduce((sum, value) => sum + value, 0) / 3;

  assert.ok(Math.abs(layout.position("extra-0").y - chainY) > 80);
});
