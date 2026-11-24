import { test, after } from "node:test";
import assert from "node:assert/strict";
import { initRepo, git, write, lines, cleanup } from "./helpers/repo.js";
import { createGit } from "../src/core/git.js";
import { nodePlatform } from "../src/adapters/node-platform.js";
import { diffTargetFor } from "../src/core/diff-target.js";
import { loadDiff } from "../src/core/diff.js";

after(cleanup);

const gitRunner = createGit(nodePlatform);

/** Loads the Diff view's split rows for `path` in `group`. */
async function splitRows(root, path, group = "changes") {
  const target = diffTargetFor({ machine: null, toplevel: root }, { path, status: "M", group });
  const doc = await loadDiff(gitRunner, target);
  return { doc, rows: doc.rows("split") };
}

/** A compact picture of a split row: "kind L:text | R:text". */
const pic = (r) => `${r.kind} ${r.left ? `${r.left.line}:${r.left.text}` : "-"} | ${r.right ? `${r.right.line}:${r.right.text}` : "-"}`;

test("a modified line pairs with its old version, and the whole file is shown", async () => {
  const root = initRepo({ files: { "a.txt": lines(["one", "two", "three", "four", "five"]) } });
  write(root, "a.txt", lines(["one", "two", "THREE", "four", "five"]));
  const { doc, rows } = await splitRows(root, "a.txt");
  assert.deepEqual(rows.map(pic), [
    "ctx 1:one | 1:one",
    "ctx 2:two | 2:two",
    "mod 3:three | 3:THREE",
    "ctx 4:four | 4:four",
    "ctx 5:five | 5:five",
  ]);
  assert.equal(doc.adds, 1);
  assert.equal(doc.dels, 1);
});

test("a modified row marks the changed middle of each side, without the common prefix and suffix", async () => {
  const root = initRepo({ files: { "a.js": lines(["const total = price * count;"]) } });
  write(root, "a.js", lines(["const total = price * quantity + tax;"]));
  const { rows } = await splitRows(root, "a.js");
  assert.equal(rows.length, 1);
  // "const total = price * " is common; ";" is the common suffix.
  assert.deepEqual(rows[0].left.changed, [22, 27]);  // "count"
  assert.deepEqual(rows[0].right.changed, [22, 36]); // "quantity + tax"
});

test("a prefix and suffix never overlap when one side contains the other", async () => {
  const root = initRepo({ files: { "a.txt": lines(["aaa"]) } });
  write(root, "a.txt", lines(["aaaa"]));
  const { rows } = await splitRows(root, "a.txt");
  assert.deepEqual(rows[0].left.changed, [3, 3]);
  assert.deepEqual(rows[0].right.changed, [3, 4]);
});

test("context rows and unpaired rows carry no intra-line ranges", async () => {
  const root = initRepo({ files: { "a.txt": lines(["keep", "gone"]) } });
  write(root, "a.txt", lines(["keep"]));
  const { rows } = await splitRows(root, "a.txt");
  assert.equal(rows[0].left.changed, undefined);
  assert.equal(rows[1].left.changed, undefined);
});

test("added lines have an empty left half and deleted lines an empty right half", async () => {
  const root = initRepo({ files: { "a.txt": lines(["a", "b", "c", "d"]) } });
  write(root, "a.txt", lines(["a", "new1", "new2", "b", "d"]));
  const { doc, rows } = await splitRows(root, "a.txt");
  assert.deepEqual(rows.map(pic), [
    "ctx 1:a | 1:a",
    "add - | 2:new1",
    "add - | 3:new2",
    "ctx 2:b | 4:b",
    "del 3:c | -",
    "ctx 4:d | 5:d",
  ]);
  assert.equal(doc.adds, 2);
  assert.equal(doc.dels, 1);
});

test("within a change block the i-th deletion pairs with the i-th addition; leftovers stand alone", async () => {
  const root = initRepo({ files: { "a.txt": lines(["x", "1", "2", "3", "4", "y", "p", "z"]) } });
  write(root, "a.txt", lines(["x", "one", "y", "P", "Q", "R", "z"]));
  const { rows } = await splitRows(root, "a.txt");
  assert.deepEqual(rows.map(pic), [
    "ctx 1:x | 1:x",
    "mod 2:1 | 2:one",
    "del 3:2 | -",
    "del 4:3 | -",
    "del 5:4 | -",
    "ctx 6:y | 3:y",
    "mod 7:p | 4:P",
    "add - | 5:Q",
    "add - | 6:R",
    "ctx 8:z | 7:z",
  ]);
  assert.deepEqual(rows.map((r) => r.block), [undefined, 0, 0, 0, 0, undefined, 1, 1, 1, undefined]);
});

test("a staged Change shows HEAD against the index, not the working tree", async () => {
  const root = initRepo({ files: { "a.txt": lines(["one"]) } });
  write(root, "a.txt", lines(["two"]));
  git(root, "add", "a.txt");
  write(root, "a.txt", lines(["three"]));
  assert.deepEqual((await splitRows(root, "a.txt", "staged")).rows.map(pic), ["mod 1:one | 1:two"]);
  assert.deepEqual((await splitRows(root, "a.txt", "changes")).rows.map(pic), ["mod 1:two | 1:three"]);
});

test("a staged rename shows the old file against the new one", async () => {
  const root = initRepo({ files: { "old.txt": lines(["a", "b", "c", "d"]) } });
  git(root, "mv", "old.txt", "new.txt");
  write(root, "new.txt", lines(["a", "b", "c", "D"]));
  git(root, "add", "new.txt");
  const target = diffTargetFor({ machine: null, toplevel: root }, { path: "new.txt", oldPath: "old.txt", status: "R", group: "staged" });
  const rows = (await loadDiff(gitRunner, target)).rows("split");
  assert.deepEqual(rows.map(pic), ["ctx 1:a | 1:a", "ctx 2:b | 2:b", "ctx 3:c | 3:c", "mod 4:d | 4:D"]);
});

test("an untracked file shows every line as added", async () => {
  const root = initRepo();
  write(root, "u.txt", lines(["new", "file"]));
  const target = diffTargetFor({ machine: null, toplevel: root }, { path: "u.txt", status: "A", group: "untracked" });
  const doc = await loadDiff(gitRunner, target);
  assert.deepEqual(doc.rows("split").map(pic), ["add - | 1:new", "add - | 2:file"]);
  assert.equal(doc.adds, 2);
});

test("a missing final newline is marked on its line", async () => {
  const root = initRepo({ files: { "a.txt": "one\ntwo\n" } });
  write(root, "a.txt", "one\ntwo");
  const { rows } = await splitRows(root, "a.txt");
  assert.deepEqual(rows.map(pic), ["ctx 1:one | 1:one", "mod 2:two | 2:two"]);
  assert.equal(rows[1].left.noeol, undefined);
  assert.equal(rows[1].right.noeol, true);
});

test("a diff that git can't produce rejects with git's message", async () => {
  const root = initRepo();
  const target = diffTargetFor({ machine: null, toplevel: root + "/missing" }, { path: "a", status: "M", group: "changes" });
  await assert.rejects(loadDiff(gitRunner, target), { name: "DiffLoadError" });
});

test("a configured textconv filter or external diff tool doesn't change the Diff view", async () => {
  const root = initRepo({ files: { "a.txt": lines(["one"]), ".gitattributes": "*.txt diff=shout\n" } });
  git(root, "config", "diff.shout.textconv", "sed s/^/SHOUT-/");
  git(root, "config", "diff.external", "false");
  write(root, "a.txt", lines(["two"]));
  assert.deepEqual((await splitRows(root, "a.txt")).rows.map(pic), ["mod 1:one | 1:two"]);
});

test("the Workbench loads a Diff target without following its Repository", async () => {
  const { createWorkbench } = await import("../src/core/workbench.js");
  const root = initRepo({ files: { "a.txt": lines(["one"]) } });
  write(root, "a.txt", lines(["two"]));
  const workbench = createWorkbench(nodePlatform);
  const target = diffTargetFor({ machine: null, toplevel: root }, { path: "a.txt", status: "M", group: "changes" });
  assert.deepEqual((await workbench.loadDiff(target)).rows("split").map(pic), ["mod 1:one | 1:two"]);
});
