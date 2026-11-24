import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { initRepo, unbornRepo, git, write, cleanup } from "./helpers/repo.js";
import { createWorkbench } from "../src/core/workbench.js";
import { nodePlatform } from "../src/adapters/node-platform.js";

after(cleanup);

/** Follows `folder` and returns the Repository's snapshot groups. */
async function groupsOf(folder) {
  const workbench = createWorkbench(nodePlatform);
  await workbench.follow({ machine: null, folder });
  assert.equal(workbench.state.kind, "ready");
  return workbench.state.repository.snapshot.groups;
}

test("an edited tracked file is an unstaged Change", async () => {
  const root = initRepo({ files: { "src/a.txt": "one\n" } });
  write(root, "src/a.txt", "two\n");
  const groups = await groupsOf(root);
  assert.deepEqual(groups, {
    staged: [],
    changes: [{ path: "src/a.txt", status: "M", group: "changes" }],
    untracked: [],
    conflicts: [],
  });
});

test("a staged new file is a staged Change with status A", async () => {
  const root = initRepo();
  write(root, "new.txt", "n\n");
  git(root, "add", "new.txt");
  const groups = await groupsOf(root);
  assert.deepEqual(groups.staged, [{ path: "new.txt", status: "A", group: "staged" }]);
  assert.deepEqual(groups.changes, []);
});

test("deleted files are D, staged or not", async () => {
  const root = initRepo({ files: { "gone.txt": "g\n", "rm.txt": "r\n" } });
  git(root, "rm", "-q", "rm.txt");
  fs.rmSync(path.join(root, "gone.txt"));
  const groups = await groupsOf(root);
  assert.deepEqual(groups.staged, [{ path: "rm.txt", status: "D", group: "staged" }]);
  assert.deepEqual(groups.changes, [{ path: "gone.txt", status: "D", group: "changes" }]);
});

test("a path with staged and unstaged edits appears in both lists", async () => {
  const root = initRepo({ files: { "both.txt": "1\n" } });
  write(root, "both.txt", "2\n");
  git(root, "add", "both.txt");
  write(root, "both.txt", "3\n");
  const groups = await groupsOf(root);
  assert.deepEqual(groups.staged, [{ path: "both.txt", status: "M", group: "staged" }]);
  assert.deepEqual(groups.changes, [{ path: "both.txt", status: "M", group: "changes" }]);
});

test("untracked files are listed one by one, including inside new folders", async () => {
  const root = initRepo();
  write(root, "loose.txt", "x\n");
  write(root, "newdir/inner/a.txt", "a\n");
  const groups = await groupsOf(root);
  assert.deepEqual(groups.untracked, [
    { path: "loose.txt", status: "A", group: "untracked" },
    { path: "newdir/inner/a.txt", status: "A", group: "untracked" },
  ]);
});

test("a staged rename shows its old path", async () => {
  const root = initRepo({ files: { "old/name.txt": "same content\nline two\nline three\n" } });
  git(root, "mv", "old/name.txt", "renamed.txt");
  const groups = await groupsOf(root);
  assert.deepEqual(groups.staged, [{ path: "renamed.txt", oldPath: "old/name.txt", status: "R", group: "staged" }]);
});

test("a rename with further unstaged edits is in both lists", async () => {
  const root = initRepo({ files: { "a.txt": "one\ntwo\nthree\nfour\n" } });
  git(root, "mv", "a.txt", "b.txt");
  write(root, "b.txt", "one\ntwo\nthree\nfour\nfive\n");
  const groups = await groupsOf(root);
  assert.deepEqual(groups.staged, [{ path: "b.txt", oldPath: "a.txt", status: "R", group: "staged" }]);
  assert.deepEqual(groups.changes, [{ path: "b.txt", status: "M", group: "changes" }]);
});

test("a file staged as a symlink is a type change", async () => {
  const root = initRepo({ files: { "link": "target\n" } });
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: "target" }).toString().trim();
  git(root, "update-index", "--cacheinfo", `120000,${blob},link`);
  const groups = await groupsOf(root);
  assert.deepEqual(groups.staged, [{ path: "link", status: "T", group: "staged" }]);
});

test("filenames with spaces and Unicode are listed exactly", async () => {
  const root = initRepo({ files: { "dir with space/café 日本.txt": "1\n" } });
  write(root, "dir with space/café 日本.txt", "2\n");
  write(root, "  leading and trailing  .txt", "x\n");
  const groups = await groupsOf(root);
  assert.deepEqual(groups.changes.map((c) => c.path), ["dir with space/café 日本.txt"]);
  assert.deepEqual(groups.untracked.map((c) => c.path), ["  leading and trailing  .txt"]);
});

test("filenames with quotes and newlines are listed exactly", async () => {
  // Windows can't hold these names on disk, so they live only in the index:
  // each is a staged addition and an unstaged deletion.
  const root = initRepo();
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: "x\n" }).toString().trim();
  const names = ['say "hi".txt', "two\nlines.txt", "tab\there.txt"];
  for (const name of names) git(root, "-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${blob},${name}`);
  const groups = await groupsOf(root);
  const sorted = [...names].sort();
  assert.deepEqual(groups.staged.map((c) => c.path).sort(), sorted);
  assert.deepEqual(groups.changes.map((c) => c.path).sort(), sorted);
  assert.ok(groups.staged.every((c) => c.status === "A"));
  assert.ok(groups.changes.every((c) => c.status === "D"));
});

test("CRLF and LF files are both listed, and untouched CRLF files are not", async () => {
  const root = initRepo({ files: { "crlf.txt": "a\r\nb\r\n", "lf.txt": "a\nb\n", "still.txt": "x\r\ny\r\n" } });
  write(root, "crlf.txt", "a\r\nB\r\n");
  write(root, "lf.txt", "a\nB\n");
  const groups = await groupsOf(root);
  assert.deepEqual(groups.changes.map((c) => c.path), ["crlf.txt", "lf.txt"]);
});

test("a repository with no commits lists its Changes", async () => {
  const root = unbornRepo();
  write(root, "staged.txt", "s\n");
  git(root, "add", "staged.txt");
  write(root, "loose.txt", "l\n");
  const groups = await groupsOf(root);
  assert.deepEqual(groups, {
    staged: [{ path: "staged.txt", status: "A", group: "staged" }],
    changes: [],
    untracked: [{ path: "loose.txt", status: "A", group: "untracked" }],
    conflicts: [],
  });
});

test("an unmerged path is a Conflict with status U", async () => {
  const root = initRepo({ files: { "f.txt": "base\n" } });
  git(root, "checkout", "-q", "-b", "other");
  write(root, "f.txt", "theirs\n");
  git(root, "commit", "-q", "-am", "theirs");
  git(root, "checkout", "-q", "main");
  write(root, "f.txt", "ours\n");
  git(root, "commit", "-q", "-am", "ours");
  assert.throws(() => git(root, "merge", "-q", "other"));
  const groups = await groupsOf(root);
  assert.deepEqual(groups, {
    staged: [],
    changes: [],
    untracked: [],
    conflicts: [{ path: "f.txt", status: "U", group: "conflicts" }],
  });
});
