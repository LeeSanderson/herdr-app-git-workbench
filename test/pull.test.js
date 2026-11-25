// @ts-check
// Pull at the Workbench seam, against a local bare repository as the remote (no
// network, no credential prompts). The helpers isolate Git from the user's global
// and system config, so with no pull config set here, none is in effect.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, remoteRepo, commitFile, git, write } from "./helpers/repo.js";
import { createWorkbench } from "../src/core/workbench.js";
import { nodePlatform } from "../src/adapters/node-platform.js";

after(cleanup);

/** @param {string} folder */
async function follow(folder) {
  const workbench = createWorkbench(nodePlatform);
  await workbench.follow({ machine: null, folder });
  assert.equal(workbench.state.kind, "ready");
  return /** @type {any} */ (workbench.state).repository;
}

/** The commit `ref` names. */
const tip = (dir, ref) => git(dir, "rev-parse", ref).trim();
/** The parents of HEAD. */
const parents = (dir) => git(dir, "log", "-1", "--format=%P").trim().split(" ").filter(Boolean);
/** The repository's local config, to check a pull never writes it. */
const localConfig = (dir) => git(dir, "config", "--local", "--list");

/** Someone else pushes a commit to the remote. */
function theyPush(other, file = "o.txt", content = "o\n") {
  commitFile(other, file, content, "Someone else's work");
  git(other, "push", "-q");
}

test("pull fast-forwards to the Upstream", async () => {
  const { remote, root, other } = remoteRepo();
  theyPush(other);
  const repository = await follow(root);

  const result = await repository.sync("pull");

  assert.deepEqual(result, { ok: true });
  assert.equal(tip(root, "HEAD"), tip(remote, "main"));
  assert.equal(repository.snapshot.behind, 0);
  assert.equal(repository.snapshot.lastError, null);
});

/** A working copy whose branch has diverged from its Upstream (no conflict). */
function diverged() {
  const repos = remoteRepo();
  theyPush(repos.other);
  commitFile(repos.root, "b.txt", "b\n", "Local work");
  return repos;
}

test("with pull.rebase true, pull rebases the local commits onto the Upstream", async () => {
  const { remote, root } = diverged();
  git(root, "config", "pull.rebase", "true");
  const config = localConfig(root);
  const repository = await follow(root);

  assert.deepEqual(await repository.sync("pull"), { ok: true });

  assert.deepEqual(parents(root), [tip(remote, "main")]);
  assert.equal(git(root, "log", "-1", "--format=%s").trim(), "Local work");
  assert.equal(repository.snapshot.ahead, 1);
  assert.equal(repository.snapshot.behind, 0);
  assert.equal(localConfig(root), config);
});

test("with pull.rebase false, pull merges the Upstream", async () => {
  const { remote, root } = diverged();
  git(root, "config", "pull.rebase", "false");
  const local = tip(root, "HEAD");
  const repository = await follow(root);

  assert.deepEqual(await repository.sync("pull"), { ok: true });

  assert.deepEqual(parents(root), [local, tip(remote, "main")]);
  assert.equal(repository.snapshot.behind, 0);
});

const DIVERGED = "Your branch and its Upstream have diverged";

test("with pull.ff only, a diverged pull gives the divergence message and changes nothing", async () => {
  const { root } = diverged();
  git(root, "config", "pull.ff", "only");
  const local = tip(root, "HEAD");
  const repository = await follow(root);

  const result = await repository.sync("pull");

  assert.equal(result.ok, false);
  assert.equal(result.error.summary, DIVERGED);
  assert.equal(tip(root, "HEAD"), local);
  assert.equal(repository.snapshot.behind, 1);
});

/**
 * Pulls a diverged branch with no pull config (fast-forward only), checks the
 * divergence message, then runs its `label` action as the panel does.
 */
async function pullDivergedThen(label) {
  const { remote, root } = diverged();
  const local = tip(root, "HEAD");
  const config = localConfig(root);
  const repository = await follow(root);

  const first = await repository.sync("pull");
  assert.equal(first.ok, false);
  assert.equal(first.error.summary, DIVERGED);
  assert.deepEqual(first.error.actions.map((a) => a.label), ["Pull (merge)", "Pull (rebase)"]);
  assert.equal(tip(root, "HEAD"), local);

  const action = first.error.actions.find((a) => a.label === label);
  const second = await repository.sync(action.sync, { ...action.options });
  assert.deepEqual(second, { ok: true });
  assert.equal(repository.snapshot.behind, 0);
  assert.equal(repository.snapshot.lastError, null);
  assert.equal(localConfig(root), config);
  return { remote, root, local };
}

test("a diverged pull with no config offers Pull (merge), which merges without writing config", async () => {
  const { remote, root, local } = await pullDivergedThen("Pull (merge)");
  assert.deepEqual(parents(root), [local, tip(remote, "main")]);
});

test("a diverged pull with no config offers Pull (rebase), which rebases without writing config", async () => {
  const { remote, root } = await pullDivergedThen("Pull (rebase)");
  assert.deepEqual(parents(root), [tip(remote, "main")]);
  assert.equal(git(root, "log", "-1", "--format=%s").trim(), "Local work");
});

test("a pull that would overwrite local changes refuses, with the file count, and stashes nothing", async () => {
  const { root, other } = remoteRepo({ files: { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" } });
  write(other, "a.txt", "theirs a\n");
  write(other, "b.txt", "theirs b\n");
  git(other, "commit", "-q", "-am", "Their edits");
  git(other, "push", "-q");
  write(root, "a.txt", "mine a\n");
  write(root, "b.txt", "mine b\n");
  const local = tip(root, "HEAD");
  const repository = await follow(root);

  const result = await repository.sync("pull");

  assert.equal(result.ok, false);
  assert.equal(result.error.summary, "Pull would overwrite local changes in 2 files. Commit or discard them first");
  assert.match(result.error.detail, /a\.txt/);
  assert.equal(tip(root, "HEAD"), local);
  assert.equal(git(root, "stash", "list").trim(), "");
  assert.deepEqual(repository.snapshot.groups.changes.map((c) => c.path).sort(), ["a.txt", "b.txt"]);
});

for (const mode of /** @type {const} */ (["merge", "rebase"])) {
  test(`a ${mode} pull that stops with conflicts leaves Conflicts and an Operation in progress`, async () => {
    const { root, other } = remoteRepo({ files: { "a.txt": "a\n", "b.txt": "b\n" } });
    write(other, "a.txt", "theirs a\n");
    write(other, "b.txt", "theirs b\n");
    git(other, "commit", "-q", "-am", "Their edits");
    git(other, "push", "-q");
    write(root, "a.txt", "mine a\n");
    write(root, "b.txt", "mine b\n");
    git(root, "commit", "-q", "-am", "My edits");
    const repository = await follow(root);

    const result = await repository.sync("pull", { mode });

    assert.equal(result.ok, false);
    assert.equal(result.error.summary, "Pull stopped with conflicts in 2 files");
    assert.equal(result.error.actions, undefined);
    assert.equal(repository.snapshot.operation, mode);
    assert.deepEqual(repository.snapshot.groups.conflicts.map((c) => c.path).sort(), ["a.txt", "b.txt"]);
  });
}

for (const [mode, parentCount] of /** @type {const} */ ([["merge", 2], ["rebase", 1]])) {
  test(`with pull.ff only, the one-off ${mode} still pulls a diverged branch`, async () => {
    const { root } = diverged();
    git(root, "config", "pull.ff", "only");
    const config = localConfig(root);
    const repository = await follow(root);

    assert.deepEqual(await repository.sync("pull", { mode }), { ok: true });

    assert.equal(parents(root).length, parentCount);
    assert.equal(repository.snapshot.behind, 0);
    assert.equal(localConfig(root), config);
  });
}
