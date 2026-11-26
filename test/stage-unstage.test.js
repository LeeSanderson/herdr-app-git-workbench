import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { cleanup, initRepo, unbornRepo, git, write, tempDir } from "./helpers/repo.js";
import { createWorkbench } from "../mods/herdr-app-git-workbench/src/core/workbench.js";
import { nodePlatform } from "./helpers/node-platform.js";

after(cleanup);

/** Follows `folder` and returns its Repository. */
async function follow(folder, platform = nodePlatform) {
  const workbench = createWorkbench(platform);
  await workbench.follow({ machine: null, folder });
  assert.equal(workbench.state.kind, "ready");
  return workbench.state.repository;
}

/** The real index: `git diff --cached --name-status`, one "X\tpath" per entry. */
const indexChanges = (root) => git(root, "diff", "--cached", "--name-status").trim().split("\n").filter(Boolean);

test("stage adds an edited file and an untracked file to the index", async () => {
  const root = initRepo({ files: { "a.txt": "a\n" } });
  write(root, "a.txt", "a2\n");
  write(root, "new dir/b c.txt", "b\n");
  const repository = await follow(root);

  const result = await repository.stage(["a.txt", "new dir/b c.txt"]);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(indexChanges(root), ["M\ta.txt", "A\tnew dir/b c.txt"]);
  assert.deepEqual(repository.snapshot.groups.staged.map((c) => c.path), ["a.txt", "new dir/b c.txt"]);
  assert.deepEqual(repository.snapshot.groups.untracked, []);
});

test("unstage takes a file out of the index and keeps its edits", async () => {
  const root = initRepo({ files: { "a.txt": "a\n", "b.txt": "b\n" } });
  write(root, "a.txt", "a2\n");
  write(root, "b.txt", "b2\n");
  git(root, "add", "-A");
  const repository = await follow(root);

  const result = await repository.unstage(["a.txt"]);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(indexChanges(root), ["M\tb.txt"]);
  assert.deepEqual(repository.snapshot.groups.changes.map((c) => c.path), ["a.txt"]);
});

test("unstage works on an unborn branch: the file goes back to untracked", async () => {
  const root = unbornRepo();
  write(root, "a.txt", "a\n");
  write(root, "b.txt", "b\n");
  git(root, "add", "-A");
  const repository = await follow(root);

  const result = await repository.unstage(["a.txt"]);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(git(root, "ls-files").trim().split("\n"), ["b.txt"]);
  assert.deepEqual(repository.snapshot.groups.untracked.map((c) => c.path), ["a.txt"]);
});

test("unstaging both sides of a staged rename restores the original path", async () => {
  const root = initRepo({ files: { "old.txt": "content\n" } });
  git(root, "mv", "old.txt", "new.txt");
  const repository = await follow(root);
  const [rename] = repository.snapshot.groups.staged;

  await repository.unstage([rename.path, rename.oldPath]);

  assert.deepEqual(indexChanges(root), []);
  assert.deepEqual(git(root, "ls-files").trim().split("\n"), ["old.txt"]);
});

test("paths are literal: a name with glob characters stages only itself", async () => {
  const root = initRepo();
  write(root, "[ab].txt", "glob\n");
  write(root, "a.txt", "a\n");
  const repository = await follow(root);

  await repository.stage(["[ab].txt"]);

  assert.deepEqual(indexChanges(root), ["A\t[ab].txt"]);
});

test("a failed action reports a summary and full detail, sets lastError, and the next success clears it", async () => {
  const root = initRepo();
  const repository = await follow(root);

  const failed = await repository.stage(["missing.txt"]);

  assert.equal(failed.ok, false);
  assert.match(failed.error.summary, /missing\.txt/);
  assert.ok(failed.error.detail.includes(failed.error.summary));
  assert.deepEqual(repository.snapshot.lastError, failed.error);

  write(root, "here.txt", "here\n");
  assert.deepEqual(await repository.stage(["here.txt"]), { ok: true });
  assert.equal(repository.snapshot.lastError, null);
});
