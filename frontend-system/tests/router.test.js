import test from "node:test";
import assert from "node:assert/strict";

test("routes log batch detail URLs to the diagnostic report page", async () => {
  globalThis.location = { hash: "#/projects/project-1/logs/batch-001" };
  globalThis.window = { addEventListener() {} };
  const { route } = await import("../js/router.js");

  assert.deepEqual(route(), {
    name: "log-report",
    params: {
      projectId: "project-1",
      batchId: "batch-001",
    },
  });
});
