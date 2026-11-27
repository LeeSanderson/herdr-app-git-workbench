import { test, after } from "node:test";
import assert from "node:assert/strict";
import { initRepo, write, lines, cleanup, docOf } from "./helpers/repo.js";
import { createGit } from "../mods/herdr-app-git-workbench/src/core/git.js";
import { nodePlatform } from "./helpers/node-platform.js";
import { diffTargetFor } from "../mods/herdr-app-git-workbench/src/core/diff-target.js";
import { loadDiff } from "../mods/herdr-app-git-workbench/src/core/diff.js";
import { foldRows } from "../mods/herdr-app-git-workbench/src/core/rows.js";

after(cleanup);

const gitRunner = createGit(nodePlatform);

const load = (root, path) =>
  loadDiff(gitRunner, diffTargetFor({ machine: null, toplevel: root }, { path, status: "M", group: "changes" })).then(docOf);

/** `n` lines "line 1".."line n", with `edits` (line number → text) applied. */
const file = (n, edits = {}) => lines(Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`));

/** A compact picture of a row: Folds as "fold N", gaps as "gap N", context runs as "ctx×N", others by kind. */
const outline = (rows) => {
  const out = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (r.kind === "ctx" && last?.startsWith("ctx×")) out[out.length - 1] = `ctx×${+last.slice(4) + 1}`;
    else if (r.kind === "ctx") out.push("ctx×1");
    else if (r.kind === "fold" || r.kind === "gap") out.push(`${r.kind} ${r.count}`);
    else out.push(r.kind);
  }
  return out;
};

/** Loads a 40-line file with `edits` and returns its rows in `mode`. */
async function rowsOf(edits, mode = "split", n = 40) {
  const root = initRepo({ files: { "a.txt": file(n) } });
  write(root, "a.txt", file(n, edits));
  return (await load(root, "a.txt")).rows(mode);
}

test("unchanged runs fold, keeping 3 lines of context beside each change", async () => {
  const rows = await rowsOf({ 20: "edited" });
  assert.deepEqual(outline(foldRows(rows, new Set())), ["fold 16", "ctx×3", "mod", "ctx×3", "fold 17"]);
});

test("a run folds only when it would hide at least 4 lines", async () => {
  // 9 lines between changes: 3 + 3 context leaves 3, too few to fold.
  assert.deepEqual(outline(foldRows(await rowsOf({ 5: "a", 15: "b" }, "split", 19), new Set())),
    ["ctx×4", "mod", "ctx×9", "mod", "ctx×4"]);
  // 10 lines between changes leaves exactly 4.
  assert.deepEqual(outline(foldRows(await rowsOf({ 5: "a", 16: "b" }, "split", 20), new Set())),
    ["ctx×4", "mod", "ctx×3", "fold 4", "ctx×3", "mod", "ctx×4"]);
});

test("an opened Fold shows its lines; the others stay folded", async () => {
  const rows = await rowsOf({ 20: "edited" });
  const folds = foldRows(rows, new Set()).filter((r) => r.kind === "fold");
  assert.deepEqual(outline(foldRows(rows, new Set([folds[1].id]))), ["fold 16", "ctx×3", "mod", "ctx×20"]);
  assert.deepEqual(outline(foldRows(rows, new Set([folds[0].id]))), ["ctx×19", "mod", "ctx×3", "fold 17"]);
});

test("inline rows fold the same lines", async () => {
  const rows = await rowsOf({ 20: "edited" }, "inline");
  assert.deepEqual(outline(foldRows(rows, new Set())), ["fold 16", "ctx×3", "del", "add", "ctx×3", "fold 17"]);
});

test("folding keeps every change reachable by the navigator", async () => {
  const { changeAnchors } = await import("../mods/herdr-app-git-workbench/src/core/rows.js");
  const folded = foldRows(await rowsOf({ 5: "a", 20: "b", 35: "c" }), new Set());
  assert.deepEqual(changeAnchors(folded).map((i) => folded[i].block), [0, 1, 2]);
});

test("Unloaded sections are left as they are, and keep no context beside them", async () => {
  const n = 6000;
  const root = initRepo({ files: { "big.txt": file(n) } });
  write(root, "big.txt", file(n, { 3000: "edited" }));
  const rows = (await load(root, "big.txt")).rows("split");
  assert.deepEqual(outline(foldRows(rows, new Set())), ["gap 2996", "ctx×3", "mod", "ctx×3", "gap 2997"]);
});

test("a Fold opened in one mode is open in the other", async () => {
  const split = await rowsOf({ 10: "a", 30: "b" }, "split");
  const inline = await rowsOf({ 10: "a", 30: "b" }, "inline");
  const opened = new Set([foldRows(split, new Set()).filter((r) => r.kind === "fold")[1].id]);
  assert.deepEqual(outline(foldRows(inline, opened)), ["fold 6", "ctx×3", "del", "add", "ctx×19", "del", "add", "ctx×3", "fold 7"]);
});
