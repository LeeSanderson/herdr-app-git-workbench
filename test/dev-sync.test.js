import { test } from "node:test";
import assert from "node:assert/strict";
import { isModFile } from "../scripts/dev-sync.mjs";

test("dev-sync copies the mod folder's files", () => {
  for (const rel of ["main.js", "mod.json", "src/core/workbench.js", "src/ui/source-control-panel.js"]) {
    assert.equal(isModFile(rel), true, rel);
  }
});

test("dev-sync leaves the files Herdr writes into the mod folder alone", () => {
  for (const rel of ["jsconfig.json", "gpui-kit.d.ts", "src/ui/gpui-kit.d.ts", ".main.js.tmp", ".cache/x.json"]) {
    assert.equal(isModFile(rel), false, rel);
  }
});
