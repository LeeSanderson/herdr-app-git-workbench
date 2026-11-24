import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cleanup, initRepo, git, write } from "./helpers/repo.js";
import { createWorkbench } from "../src/core/workbench.js";
import { nodePlatform } from "../src/adapters/node-platform.js";

after(cleanup);

/** Follows `folder` and returns its Repository. */
async function follow(folder) {
  const workbench = createWorkbench(nodePlatform);
  await workbench.follow({ machine: null, folder });
  assert.equal(workbench.state.kind, "ready");
  return workbench.state.repository;
}

const read = (root, p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (root, p) => fs.existsSync(path.join(root, p));

test("discard restores an edited tracked file and leaves other edits alone", async () => {
  const root = initRepo({ files: { "a.txt": "a\n", "b.txt": "b\n" } });
  write(root, "a.txt", "a2\n");
  write(root, "b.txt", "b2\n");
  const repository = await follow(root);

  const result = await repository.discard(["a.txt"]);

  assert.deepEqual(result, { ok: true });
  assert.equal(read(root, "a.txt"), "a\n");
  assert.equal(read(root, "b.txt"), "b2\n");
  assert.deepEqual(repository.snapshot.groups.changes.map((c) => c.path), ["b.txt"]);
});

test("discard keeps what is staged: the file goes back to its staged content", async () => {
  const root = initRepo({ files: { "a.txt": "a\n" } });
  write(root, "a.txt", "staged\n");
  git(root, "add", "a.txt");
  write(root, "a.txt", "unstaged\n");
  const repository = await follow(root);

  await repository.discard(["a.txt"]);

  assert.equal(read(root, "a.txt"), "staged\n");
  assert.deepEqual(repository.snapshot.groups.staged.map((c) => c.path), ["a.txt"]);
  assert.deepEqual(repository.snapshot.groups.changes, []);
});

test("discard brings back a deleted tracked file", async () => {
  const root = initRepo({ files: { "gone.txt": "here\n" } });
  fs.rmSync(path.join(root, "gone.txt"));
  const repository = await follow(root);

  assert.deepEqual(await repository.discard(["gone.txt"]), { ok: true });

  assert.equal(read(root, "gone.txt"), "here\n");
});

test("a failed discard reports the error and sets lastError", async () => {
  const root = initRepo();
  const repository = await follow(root);

  const failed = await repository.discard(["missing.txt"]);

  assert.equal(failed.ok, false);
  assert.match(failed.error.summary, /missing\.txt/);
  assert.deepEqual(repository.snapshot.lastError, failed.error);
});

test("discard removes an untracked file and keeps other untracked files", async () => {
  const root = initRepo({ files: { "a.txt": "a\n" } });
  write(root, "new dir/b c.txt", "b\n");
  write(root, "keep.txt", "k\n");
  const repository = await follow(root);

  const result = await repository.discard(["new dir/b c.txt"]);

  assert.deepEqual(result, { ok: true });
  assert.equal(exists(root, "new dir/b c.txt"), false);
  assert.equal(exists(root, "keep.txt"), true);
  assert.deepEqual(repository.snapshot.groups.untracked.map((c) => c.path), ["keep.txt"]);
});
