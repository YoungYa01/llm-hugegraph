import assert from "node:assert/strict";
import test from "node:test";

import { buildNavigationModel } from "../src/js/navigation.js";

test("workspace and project pages keep the same two-level navigation structure", () => {
  const workspace = buildNavigationModel({ current: "projects", isAdmin: true });
  const project = buildNavigationModel({ project: { id: "project-1", name: "订单系统" }, current: "logs", isAdmin: true });

  assert.deepEqual(workspace.map((section) => section.key), ["workspace", "project", "system"]);
  assert.deepEqual(project.map((section) => section.key), ["workspace", "project", "system"]);
  assert.deepEqual(
    workspace.map((section) => section.items.map((item) => item.key)),
    project.map((section) => section.items.map((item) => item.key)),
  );
});

test("project submenu keeps its model and is enabled only after a project is selected", () => {
  const workspace = buildNavigationModel({ current: "projects", isAdmin: false });
  const projectSection = workspace.find((section) => section.key === "project");
  assert.equal(projectSection.items.length, 5);
  assert.deepEqual(projectSection.items.map((item) => item.key), ["overview", "architecture", "logs", "incidents", "reports"]);
  assert.equal(projectSection.items.every((item) => item.disabled), true);

  const selected = buildNavigationModel({ project: { id: "a/b", name: "Demo" }, current: "architecture" });
  const selectedProject = selected.find((section) => section.key === "project");
  assert.equal(selectedProject.items.every((item) => !item.disabled), true);
  assert.equal(selectedProject.items.find((item) => item.key === "architecture").href, "#/projects/a%2Fb/architecture");
  assert.equal(selectedProject.items.find((item) => item.key === "architecture").active, true);
});
