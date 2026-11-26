import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cleanup, initRepo, unbornRepo, git, write } from "./helpers/repo.js";
import { createWorkbench } from "../mods/herdr-app-git-workbench/src/core/workbench.js";
import { nodePlatform } from "./helpers/node-platform.js";

after(cleanup);

/** Follows `folder` and returns its Repository. */
async function follow(folder) {
  const workbench = createWorkbench(nodePlatform);
  await workbench.follow({ machine: null, folder });
  assert.equal(workbench.state.kind, "ready");
  return workbench.state.repository;
}

/** Installs a pre-commit hook that prints two lines and fails. Returns a function that removes it. */
function failingHook(root) {
  const hook = path.join(root, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\necho 'lint: 3 problems' >&2\necho 'src/a.js:1 missing semicolon' >&2\nexit 1\n", { mode: 0o755 });
  return () => fs.rmSync(hook);
}

/** The message of the latest commit, exactly as stored. */
const lastMessage = (root) => git(root, "log", "-1", "--format=%B");

test("commit stores the message verbatim: quotes, newlines, leading dashes", async () => {
  const root = initRepo();
  write(root, "a.txt", "a\n");
  git(root, "add", "a.txt");
  const repository = await follow(root);
  const message = `--amend "quoted" 'single' $HOME %PATH% \`tick\`\n\n- bullet\n--no-verify\n# not a comment`;

  const result = await repository.commit({ message });

  assert.deepEqual(result, { ok: true });
  assert.equal(lastMessage(root), message + "\n\n");
  assert.equal(git(root, "rev-list", "--count", "HEAD").trim(), "2");
  assert.deepEqual(repository.snapshot.groups.staged, []);
});

test("a failing hook blocks the commit: detail carries its full output, lastError is set, then cleared by a later success", async () => {
  const root = initRepo();
  write(root, "a.txt", "a\n");
  git(root, "add", "a.txt");
  const removeHook = failingHook(root);
  const repository = await follow(root);

  const failed = await repository.commit({ message: "Add a" });

  assert.equal(failed.ok, false);
  assert.match(failed.error.detail, /lint: 3 problems\n.*src\/a\.js:1 missing semicolon/s);
  assert.deepEqual(repository.snapshot.lastError, failed.error);
  assert.equal(git(root, "rev-list", "--count", "HEAD").trim(), "1");
  assert.deepEqual(repository.snapshot.groups.staged.map((c) => c.path), ["a.txt"]);

  removeHook();
  assert.deepEqual(await repository.commit({ message: "Add a" }), { ok: true });
  assert.equal(repository.snapshot.lastError, null);
});

test("the first commit in a repository with no commits", async () => {
  const root = unbornRepo();
  write(root, "a.txt", "a\n");
  git(root, "add", "a.txt");
  const repository = await follow(root);
  assert.equal(repository.snapshot.unborn, true);

  assert.deepEqual(await repository.commit({ message: "First" }), { ok: true });

  assert.equal(lastMessage(root), "First\n\n");
  assert.equal(repository.snapshot.unborn, false);
  assert.equal(repository.snapshot.branch, "main");
  assert.deepEqual(repository.snapshot.groups.staged, []);
});
