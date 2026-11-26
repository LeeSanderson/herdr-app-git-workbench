import { test } from "node:test";
import assert from "node:assert/strict";
import { diffTargetFor, targetKey, tabName } from "../mods/herdr-app-git-workbench/src/core/diff-target.js";

const key = { machine: null, toplevel: "C:/repo" };

test("a staged Change compares HEAD with the index", () => {
  const t = diffTargetFor(key, { path: "src/a.js", status: "M", group: "staged" });
  assert.deepEqual(t, {
    repository: { machine: null, toplevel: "C:/repo" },
    left: "HEAD", right: "INDEX", oldPath: "src/a.js", newPath: "src/a.js", group: "staged", status: "M",
  });
});

test("a staged rename keeps its old path on the left", () => {
  const t = diffTargetFor(key, { path: "new.js", oldPath: "old.js", status: "R", group: "staged" });
  assert.equal(t.left, "HEAD");
  assert.equal(t.right, "INDEX");
  assert.equal(t.oldPath, "old.js");
  assert.equal(t.newPath, "new.js");
});

test("an unstaged Change compares the index with the working tree", () => {
  const t = diffTargetFor(key, { path: "a.js", status: "M", group: "changes" });
  assert.equal(t.left, "INDEX");
  assert.equal(t.right, "WORKTREE");
});

test("an untracked file compares an empty side with the working tree", () => {
  const t = diffTargetFor(key, { path: "u.txt", status: "A", group: "untracked" });
  assert.equal(t.left, "EMPTY");
  assert.equal(t.right, "WORKTREE");
});

test("a Conflict compares the index with the working tree", () => {
  const t = diffTargetFor(key, { path: "c.txt", status: "U", group: "conflicts" });
  assert.equal(t.left, "INDEX");
  assert.equal(t.right, "WORKTREE");
});

test("a Diff target is plain JSON", () => {
  const t = diffTargetFor({ machine: "box", toplevel: "/r" }, { path: "a", status: "M", group: "changes" });
  assert.deepEqual(JSON.parse(JSON.stringify(t)), t);
});

test("staged and unstaged diffs of one file have different keys", () => {
  const staged = diffTargetFor(key, { path: "a.js", status: "M", group: "staged" });
  const unstaged = diffTargetFor(key, { path: "a.js", status: "M", group: "changes" });
  assert.notEqual(targetKey(staged), targetKey(unstaged));
  assert.equal(targetKey(staged), targetKey(diffTargetFor({ ...key }, { path: "a.js", status: "M", group: "staged" })));
});

test("the same file in another repository has a different key", () => {
  const a = diffTargetFor(key, { path: "a.js", status: "M", group: "changes" });
  const b = diffTargetFor({ machine: null, toplevel: "C:/other" }, { path: "a.js", status: "M", group: "changes" });
  assert.notEqual(targetKey(a), targetKey(b));
});

test("tab names show the file name and mark staged diffs", () => {
  assert.equal(tabName(diffTargetFor(key, { path: "src/a.js", status: "M", group: "changes" })), "Δ a.js");
  assert.equal(tabName(diffTargetFor(key, { path: "src/a.js", status: "M", group: "staged" })), "Δ a.js (staged)");
});
