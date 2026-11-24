import { test, after } from "node:test";
import assert from "node:assert/strict";
import { initRepo, git, write, lines, cleanup } from "./helpers/repo.js";
import { createGit } from "../src/core/git.js";
import { nodePlatform } from "../src/adapters/node-platform.js";
import { diffTargetFor } from "../src/core/diff-target.js";
import { loadDiff } from "../src/core/diff.js";

after(cleanup);

const gitRunner = createGit(nodePlatform);

/** `n` lines; every 1000th (from line 1) is a "section" header git picks as a function title. */
const file = (n, edits = {}) =>
  lines(Array.from({ length: n }, (_, i) => edits[i + 1] ?? (i % 1000 === 0 ? `section ${i + 1}` : `  row ${i + 1}`)));

const load = (root, path, group = "changes", status = "M") =>
  loadDiff(gitRunner, diffTargetFor({ machine: null, toplevel: root }, { path, status, group }));

/** A compact picture of a row: gap rows as "gap N title", others as "kind left|right". */
const pic = (r) => r.kind === "gap"
  ? `gap ${r.count} ${r.title}`.trimEnd()
  : r.left !== undefined
    ? `${r.kind} ${r.left?.line ?? "-"}|${r.right?.line ?? "-"}`
    : `${r.kind} ${r.a ?? "-"}|${r.b ?? "-"}`;

/** The rows with runs of context collapsed to "ctx×N". */
const outline = (rows) => {
  const out = [];
  for (const r of rows) {
    if (r.kind === "ctx") {
      const last = out[out.length - 1];
      if (last?.startsWith("ctx×")) out[out.length - 1] = `ctx×${+last.slice(4) + 1}`;
      else out.push("ctx×1");
    } else out.push(pic(r));
  }
  return out;
};

test("a file at the 5,000-line limit loads whole", async () => {
  const root = initRepo({ files: { "big.txt": file(5000) } });
  write(root, "big.txt", file(5000, { 2500: "edited" }));
  const doc = await load(root, "big.txt");
  assert.equal(doc.truncated, false);
  assert.equal(doc.notice, null);
  assert.equal(doc.rows("split").length, 5000);
  assert.ok(doc.rows("split").every((r) => r.kind !== "gap"));
});

test("over the limit only the changed sections load, with gap rows carrying the function title", async () => {
  const root = initRepo({ files: { "big.txt": file(6000) } });
  write(root, "big.txt", file(6000, { 100: "edited 100", 3000: "edited 3000" }));
  const doc = await load(root, "big.txt");
  assert.equal(doc.truncated, true);
  assert.equal(doc.lines, 6000);
  assert.equal(doc.notice, "Only the changed sections are shown: this file has 6,000 lines, over the 5,000-line limit");
  assert.deepEqual(outline(doc.rows("split")), [
    "gap 96 section 1",
    "ctx×3", "mod 100|100", "ctx×3",
    "gap 2893 section 2001",
    "ctx×3", "mod 3000|3000", "ctx×3",
    "gap 2997",
  ]);
  assert.deepEqual(outline(doc.rows("inline")), [
    "gap 96 section 1",
    "ctx×3", "del 100|-", "add -|100", "ctx×3",
    "gap 2893 section 2001",
    "ctx×3", "del 3000|-", "add -|3000", "ctx×3",
    "gap 2997",
  ]);
  assert.equal(doc.adds, 2);
  assert.equal(doc.dels, 2);
});

test("gap rows split change blocks, so navigation still finds every change", async () => {
  const { changeAnchors } = await import("../src/core/rows.js");
  const root = initRepo({ files: { "big.txt": file(6000) } });
  write(root, "big.txt", file(6000, { 100: "a", 3000: "b", 5999: "c" }));
  const rows = (await load(root, "big.txt")).rows("split");
  assert.deepEqual(changeAnchors(rows).map((i) => rows[i].block), [0, 1, 2]);
});

test("the larger side decides: a file shrinking from over the limit to under it is truncated", async () => {
  const root = initRepo({ files: { "big.txt": file(6000) } });
  write(root, "big.txt", file(4000));
  const doc = await load(root, "big.txt");
  assert.equal(doc.truncated, true);
  assert.equal(doc.lines, 6000);
  assert.equal(outline(doc.rows("split"))[0], "gap 3997 section 3001");
});

test("a staged change over the limit compares HEAD with the index", async () => {
  const root = initRepo({ files: { "big.txt": file(6000) } });
  write(root, "big.txt", file(6000, { 10: "staged" }));
  git(root, "add", "big.txt");
  write(root, "big.txt", file(6000, { 10: "staged", 20: "unstaged" }));
  const doc = await load(root, "big.txt", "staged");
  assert.equal(doc.truncated, true);
  assert.deepEqual(outline(doc.rows("split")), ["gap 6 section 1", "ctx×3", "mod 10|10", "ctx×3", "gap 5987"]);
});

test("a new untracked file over the limit is truncated but shows every line", async () => {
  const root = initRepo();
  write(root, "new.txt", file(5001));
  const doc = await load(root, "new.txt", "untracked", "A");
  assert.equal(doc.truncated, true);
  assert.equal(doc.rows("split").length, 5001);
});
