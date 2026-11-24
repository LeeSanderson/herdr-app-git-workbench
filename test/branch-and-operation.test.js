import { test, after } from "node:test";
import assert from "node:assert/strict";
import { initRepo, tempDir, git, write, cleanup } from "./helpers/repo.js";
import { createWorkbench } from "../src/core/workbench.js";
import { nodePlatform } from "../src/adapters/node-platform.js";

after(cleanup);

/** Follows `folder` and returns the followed Repository. */
async function follow(folder) {
  const workbench = createWorkbench(nodePlatform);
  await workbench.follow({ machine: null, folder });
  assert.equal(workbench.state.kind, "ready");
  return workbench.state.repository;
}

/** Commits `content` to `file` in `root`. */
function commit(root, file, content, message = `edit ${file}`) {
  write(root, file, content);
  git(root, "add", "--", file);
  git(root, "commit", "-q", "-m", message);
}

test("a branch without an upstream has no upstream and no ahead/behind", async () => {
  const s = (await follow(initRepo())).snapshot;
  assert.equal(s.branch, "main");
  assert.equal(s.detached, false);
  assert.equal(s.upstream, null);
  assert.equal(s.ahead, null);
  assert.equal(s.behind, null);
});

test("a branch tracking an upstream carries its name and ahead/behind counts", async () => {
  const origin = initRepo({ files: { "a.txt": "1\n" } });
  const clone = tempDir("gitwb-clone-");
  git(clone, "clone", "-q", origin, ".");
  git(clone, "config", "core.autocrlf", "false");
  git(clone, "config", "user.name", "Test");
  git(clone, "config", "user.email", "test@example.invalid");
  // Two commits upstream the clone hasn't merged, one local commit not pushed.
  commit(origin, "b.txt", "b\n");
  commit(origin, "c.txt", "c\n");
  git(clone, "fetch", "-q");
  commit(clone, "d.txt", "d\n");

  const s = (await follow(clone)).snapshot;
  assert.equal(s.branch, "main");
  assert.equal(s.upstream, "origin/main");
  assert.equal(s.ahead, 1);
  assert.equal(s.behind, 2);
});

test("a detached HEAD has no branch and says so", async () => {
  const root = initRepo();
  commit(root, "b.txt", "b\n");
  git(root, "checkout", "-q", "--detach", "HEAD~1");
  const s = (await follow(root)).snapshot;
  assert.equal(s.detached, true);
  assert.equal(s.branch, null);
  assert.equal(s.upstream, null);
  assert.equal(s.operation, "none");
});

test("a clean repository has no Operation in progress", async () => {
  const s = (await follow(initRepo())).snapshot;
  assert.equal(s.operation, "none");
  assert.deepEqual(s.groups.conflicts, []);
});

/**
 * A repository where `main` and `other` both edit f.txt's one line,
 * checked out on `main`. Returns the repo root.
 */
function divergedRepo() {
  const root = initRepo({ files: { "f.txt": "base\n", "keep.txt": "k\n" } });
  git(root, "checkout", "-q", "-b", "other");
  commit(root, "f.txt", "theirs\n", "theirs");
  git(root, "checkout", "-q", "main");
  commit(root, "f.txt", "ours\n", "ours");
  return root;
}

/** Runs a git command that is expected to stop on a conflict. */
function conflicting(root, ...args) {
  assert.throws(() => git(root, ...args));
}

const operations = {
  merge: (root) => conflicting(root, "merge", "-q", "other"),
  rebase: (root) => conflicting(root, "rebase", "other"),
  "rebase (apply backend)": (root) => conflicting(root, "rebase", "--apply", "other"),
  "cherry-pick": (root) => conflicting(root, "cherry-pick", "other"),
  revert: (root) => {
    // Revert the "theirs" commit after merging over it, so reverting conflicts with "ours".
    git(root, "checkout", "-q", "other");
    commit(root, "f.txt", "later\n", "later");
    conflicting(root, "revert", "--no-edit", "HEAD~1");
  },
};

for (const [operation, start] of Object.entries(operations)) {
  test(`a ${operation} stopped on a conflict is the Operation in progress, with the Conflict listed`, async () => {
    const root = divergedRepo();
    start(root);
    const s = (await follow(root)).snapshot;
    assert.equal(s.operation, operation.split(" ")[0]);
    assert.deepEqual(s.groups.conflicts, [{ path: "f.txt", status: "U", group: "conflicts" }]);
  });
}

test("the Operation in progress is read from a Linked worktree's own git dir", async () => {
  const root = divergedRepo();
  const wt = tempDir("gitwb-wt-");
  git(root, "worktree", "add", "-q", "--detach", wt, "main");
  conflicting(wt, "merge", "-q", "other");

  assert.equal((await follow(wt)).snapshot.operation, "merge");
  assert.equal((await follow(root)).snapshot.operation, "none");
});

test("staging a Conflict marks it resolved", async () => {
  const root = divergedRepo();
  conflicting(root, "merge", "-q", "other");
  write(root, "f.txt", "resolved\n");
  const repository = await follow(root);

  const result = await repository.stage(["f.txt"]);
  assert.deepEqual(result, { ok: true });
  const s = repository.snapshot;
  assert.deepEqual(s.groups.conflicts, []);
  assert.deepEqual(s.groups.staged, [{ path: "f.txt", status: "M", group: "staged" }]);
  assert.equal(s.operation, "merge");
  assert.equal(git(root, "show", ":f.txt"), "resolved\n");
});

test("the Repository has no markResolved", async () => {
  const repository = await follow(initRepo());
  assert.equal("markResolved" in repository, false);
});
