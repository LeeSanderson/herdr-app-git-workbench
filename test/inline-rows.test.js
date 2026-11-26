import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initRepo, write, lines, cleanup, docOf } from "./helpers/repo.js";
import { createGit } from "../mods/herdr-app-git-workbench/src/core/git.js";
import { nodePlatform } from "./helpers/node-platform.js";
import { diffTargetFor } from "../mods/herdr-app-git-workbench/src/core/diff-target.js";
import { loadDiff } from "../mods/herdr-app-git-workbench/src/core/diff.js";
import { changeAnchors } from "../mods/herdr-app-git-workbench/src/core/rows.js";

after(cleanup);

const gitRunner = createGit(nodePlatform);

/** Loads the Diff document for `path` in `group`. */
async function load(root, path, group = "changes", status = "M") {
  return loadDiff(gitRunner, diffTargetFor({ machine: null, toplevel: root }, { path, status, group })).then(docOf);
}

/** A compact picture of an inline row: "kind old new text", "-" for a missing line number. */
const pic = (r) => `${r.kind} ${r.a ?? "-"} ${r.b ?? "-"} ${r.text}`;

test("inline rows show a modified line as its deletion then its addition, with both line numbers on context", async () => {
  const root = initRepo({ files: { "a.txt": lines(["one", "two", "three", "four"]) } });
  write(root, "a.txt", lines(["one", "TWO", "three", "four"]));
  const rows = (await load(root, "a.txt")).rows("inline");
  assert.deepEqual(rows.map(pic), [
    "ctx 1 1 one",
    "del 2 - two",
    "add - 2 TWO",
    "ctx 3 3 three",
    "ctx 4 4 four",
  ]);
});

test("inline rows show added lines with only a new line number and deleted lines with only an old one", async () => {
  const root = initRepo({ files: { "a.txt": lines(["a", "b", "c", "d"]) } });
  write(root, "a.txt", lines(["a", "new1", "new2", "b", "d"]));
  const rows = (await load(root, "a.txt")).rows("inline");
  assert.deepEqual(rows.map(pic), [
    "ctx 1 1 a",
    "add - 2 new1",
    "add - 3 new2",
    "ctx 2 4 b",
    "del 3 - c",
    "ctx 4 5 d",
  ]);
  assert.ok(rows.every((r) => r.changed === undefined), "unpaired lines have no intra-line range");
});

test("an untracked file is all additions inline", async () => {
  const root = initRepo();
  write(root, "u.txt", lines(["new", "file"]));
  const rows = (await load(root, "u.txt", "untracked", "A")).rows("inline");
  assert.deepEqual(rows.map(pic), ["add - 1 new", "add - 2 file"]);
});

test("a deleted file is all deletions inline", async () => {
  const root = initRepo({ files: { "gone.txt": lines(["x", "y"]) } });
  fs.rmSync(path.join(root, "gone.txt"));
  const rows = (await load(root, "gone.txt", "changes", "D")).rows("inline");
  assert.deepEqual(rows.map(pic), ["del 1 - x", "del 2 - y"]);
});

test("inline rows use the split mode's change blocks and pairing for intra-line ranges", async () => {
  const root = initRepo({ files: { "a.txt": lines(["x", "1", "2", "3", "4", "y", "p", "z"]) } });
  write(root, "a.txt", lines(["x", "one", "y", "P", "Q", "R", "z"]));
  const doc = await load(root, "a.txt");
  const rows = doc.rows("inline");
  assert.deepEqual(rows.map(pic), [
    "ctx 1 1 x",
    "del 2 - 1",
    "del 3 - 2",
    "del 4 - 3",
    "del 5 - 4",
    "add - 2 one",
    "ctx 6 3 y",
    "del 7 - p",
    "add - 4 P",
    "add - 5 Q",
    "add - 6 R",
    "ctx 8 7 z",
  ]);
  assert.deepEqual(rows.map((r) => r.block), [undefined, 0, 0, 0, 0, 0, undefined, 1, 1, 1, 1, undefined]);
  // "1" pairs with "one", "p" with "P"; the other lines of each block are unpaired.
  assert.deepEqual(rows.map((r) => r.changed ?? null), [null, [0, 1], null, null, null, [0, 3], null, [0, 1], [0, 1], null, null, null]);
});

test("a missing final newline is marked on its inline row", async () => {
  const root = initRepo({ files: { "a.txt": "one\ntwo\n" } });
  write(root, "a.txt", "one\ntwo");
  const rows = (await load(root, "a.txt")).rows("inline");
  assert.deepEqual(rows.map(pic), ["ctx 1 1 one", "del 2 - two", "add - 2 two"]);
  assert.deepEqual(rows.map((r) => r.noeol ?? false), [false, false, true]);
});

test("change anchors are the first row of each change block, in both modes", async () => {
  const root = initRepo({ files: { "a.txt": lines(["x", "1", "2", "y", "p", "z"]) } });
  write(root, "a.txt", lines(["x", "one", "y", "P", "Q", "z"]));
  const doc = await load(root, "a.txt");
  // split:  ctx x | mod 1/one | del 2 | ctx y | mod p/P | add Q | ctx z
  assert.deepEqual(changeAnchors(doc.rows("split")), [1, 4]);
  // inline: ctx x | del 1 | del 2 | add one | ctx y | del p | add P | add Q | ctx z
  assert.deepEqual(changeAnchors(doc.rows("inline")), [1, 5]);
});

test("a file without changes has no change anchors", () => {
  assert.deepEqual(changeAnchors([]), []);
});
