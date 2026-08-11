import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  calculateClientPoint,
  calculateFitTransform,
  createViewportState,
  shouldShowEdgeLabels,
} from "../js/graph-view.js";

test("maps client coordinates through centered SVG letterboxing", () => {
  const point = calculateClientPoint(
    { left: 10, top: 20, width: 360, height: 470 },
    720,
    720,
    190,
    255,
  );

  assert.deepEqual(point, { x: 360, y: 360 });
});

test("keeps the propagation underlay transparent to pointer input", () => {
  const css = readFileSync(new URL("../styles/components.css", import.meta.url), "utf8");

  assert.match(css, /\.graph-propagation-underlay\s*\{[^}]*pointer-events:\s*none/);
});

test("fits graph bounds into the viewport with padding", () => {
  const transform = calculateFitTransform(
    { minX: 0, minY: 0, maxX: 200, maxY: 100 },
    800,
    600,
    { padding: 50, maxScale: 2.4 },
  );

  assert.deepEqual(transform, { scale: 2.4, panX: 160, panY: 180 });
});

test("keeps the graph coordinate under the pointer stable while zooming", () => {
  const viewport = createViewportState();
  viewport.zoomAt(2, 200, 100);

  assert.deepEqual(viewport.value(), { scale: 2, panX: -200, panY: -100 });
  assert.deepEqual(viewport.toWorld(200, 100), { x: 200, y: 100 });
});

test("pans without changing the zoom level", () => {
  const viewport = createViewportState({ scale: 1.5, panX: 10, panY: 20 });
  viewport.panBy(15, -8);

  assert.deepEqual(viewport.value(), { scale: 1.5, panX: 25, panY: 12 });
});

test("shows relationship labels only for sparse graphs", () => {
  assert.equal(shouldShowEdgeLabels(5, 4), true);
  assert.equal(shouldShowEdgeLabels(8, 8), false);
  assert.equal(shouldShowEdgeLabels(100, 10), true);
  assert.equal(shouldShowEdgeLabels(100, 13), false);
});
