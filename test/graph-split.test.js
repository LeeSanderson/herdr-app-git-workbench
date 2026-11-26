// @ts-check
// Story 36: the dragged size of the split between the Change groups and the Graph
// is remembered per Repository.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, initRepo } from "./helpers/repo.js";
import { createWorkbench } from "../mods/herdr-app-git-workbench/src/core/workbench.js";
import { nodePlatform, memorySettings } from "./helpers/node-platform.js";

after(cleanup);

/** @param {string} folder @param {any} platform */
async function graphOf(folder, platform) {
  const workbench = createWorkbench(platform);
  await workbench.follow({ machine: null, folder });
  assert.equal(workbench.state.kind, "ready");
  return /** @type {any} */ (workbench.state).repository.graph;
}

test("the split size is remembered per Repository and survives a reload of the mod", async () => {
  const store = new Map();
  const platform = () => ({ ...nodePlatform, ...memorySettings(store) });
  const a = initRepo();
  const b = initRepo();
  (await graphOf(a, platform())).setSplitSize(310);
  (await graphOf(b, platform())).setSplitSize(222);

  // A new Workbench over the same store: the mod loaded again.
  assert.equal((await graphOf(a, platform())).splitSize, 310);
  assert.equal((await graphOf(b, platform())).splitSize, 222);
});

test("a Repository with no dragged split has no remembered size", async () => {
  const store = new Map();
  const graph = await graphOf(initRepo(), { ...nodePlatform, ...memorySettings(store) });
  assert.equal(graph.splitSize, null);
});
