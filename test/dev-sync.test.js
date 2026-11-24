import { test } from "node:test";
import assert from "node:assert/strict";
import { isModFile } from "../scripts/dev-sync.mjs";

test("dev-sync copies the mod's runtime files", () => {
  for (const rel of ["main.js", "mod.json", "src/core/workbench.js", "src/ui/source-control-panel.js"]) {
    assert.equal(isModFile(rel), true, rel);
  }
});

test("dev-sync leaves tests, docs, scripts and the Node adapter out of the mods folder", () => {
  for (const rel of ["test/workbench.test.js", "test/helpers/repo.js", "docs/agents/domain.md", "scripts/dev-sync.mjs",
    "src/adapters/node-platform.js", "package.json", "jsconfig.json"]) {
    assert.equal(isModFile(rel), false, rel);
  }
});
