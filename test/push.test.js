// @ts-check
// Push and Publish at the Workbench seam, against a local bare repository as the
// remote (no network, no credential prompts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, remoteRepo, bareRepo, initRepo, commitFile, git } from "./helpers/repo.js";
import { createWorkbench } from "../src/core/workbench.js";
import { nodePlatform } from "../src/adapters/node-platform.js";

after(cleanup);

/** @param {string} folder */
async function follow(folder, platform = nodePlatform) {
  const workbench = createWorkbench(platform);
  await workbench.follow({ machine: null, folder });
  assert.equal(workbench.state.kind, "ready");
  return /** @type {any} */ (workbench.state).repository;
}

/** The Node platform, recording the arguments of every git command it runs. */
function recording() {
  /** @type {string[][]} */
  const calls = [];
  const platform = { ...nodePlatform, exec: (cmd, args, opts) => (calls.push(args), nodePlatform.exec(cmd, args, opts)) };
  return { platform, calls };
}

/** Any force flag push accepts, in any spelling. @param {string} arg */
const isForce = (arg) => /^--force(?:-with-lease|-if-includes)?(?:=|$)|^-[a-zA-Z]*f/.test(arg) || arg.startsWith("+");

/** The branch tip in a repository (bare or not). */
const tip = (dir, ref) => git(dir, "rev-parse", ref).trim();

test("push updates the remote and clears the ahead count", async () => {
  const { remote, root } = remoteRepo();
  commitFile(root, "b.txt", "b\n", "Local work");
  const repository = await follow(root);
  assert.equal(repository.snapshot.ahead, 1);

  const result = await repository.sync("push");

  assert.deepEqual(result, { ok: true });
  assert.equal(tip(remote, "main"), tip(root, "HEAD"));
  assert.equal(repository.snapshot.ahead, 0);
  assert.equal(repository.snapshot.lastError, null);
});

test("a push the remote rejects says to pull first, and never forces", async () => {
  const { remote, root, other } = remoteRepo();
  commitFile(other, "o.txt", "o\n", "Someone else's work");
  git(other, "push", "-q");
  commitFile(root, "b.txt", "b\n", "Local work");
  const theirs = tip(remote, "main");
  const { platform, calls } = recording();
  const repository = await follow(root, platform);

  const result = await repository.sync("push");

  assert.equal(result.ok, false);
  assert.equal(result.error.summary, "Push rejected: the remote has commits you don't have. Pull first");
  assert.match(result.error.detail, /\[rejected\]/);
  assert.deepEqual(repository.snapshot.lastError, result.error);
  assert.equal(tip(remote, "main"), theirs);
  const pushes = calls.filter((args) => args.includes("push"));
  assert.ok(pushes.length > 0);
  assert.deepEqual(pushes.flat().filter(isForce), []);
});

test("a rejected push offers a Pull button that runs a pull", async () => {
  const { remote, root, other } = remoteRepo();
  commitFile(other, "o.txt", "o\n", "Someone else's work");
  git(other, "push", "-q");
  commitFile(root, "b.txt", "b\n", "Local work");
  git(root, "config", "pull.rebase", "true");
  const repository = await follow(root);

  const rejected = await repository.sync("push");
  assert.deepEqual(rejected.error.actions.map((a) => a.label), ["Pull"]);
  const [pull] = rejected.error.actions;

  assert.deepEqual(await repository.sync(pull.sync, { ...pull.options }), { ok: true });
  assert.equal(git(root, "log", "-1", "--format=%P").trim(), tip(remote, "main"));
  assert.equal(repository.snapshot.behind, 0);
  assert.deepEqual(await repository.sync("push"), { ok: true });
});

test("a push rejected as non-fast-forward after a fetch gives the same message", async () => {
  const { root, other } = remoteRepo();
  commitFile(other, "o.txt", "o\n", "Someone else's work");
  git(other, "push", "-q");
  commitFile(root, "b.txt", "b\n", "Local work");
  git(root, "fetch", "-q");
  const repository = await follow(root);

  const result = await repository.sync("push");

  assert.equal(result.ok, false);
  assert.equal(result.error.summary, "Push rejected: the remote has commits you don't have. Pull first");
});

test("a push Git refuses for want of an Upstream says to publish first", async () => {
  // The branch names a merge ref but no remote: Git sees no Upstream.
  const { root } = remoteRepo();
  git(root, "config", "--unset", "branch.main.remote");
  const repository = await follow(root);

  const result = await repository.sync("push");

  assert.equal(result.ok, false);
  assert.equal(result.error.summary, "Push needs an Upstream, and this branch has none. Publish it first");
});

test("Publish pushes a branch with no Upstream and sets one", async () => {
  const { remote, root } = remoteRepo();
  git(root, "switch", "-q", "-c", "feature");
  commitFile(root, "f.txt", "f\n", "Feature work");
  const repository = await follow(root);
  assert.equal(repository.snapshot.upstream, null);

  const result = await repository.sync("push");

  assert.deepEqual(result, { ok: true });
  assert.equal(tip(remote, "feature"), tip(root, "HEAD"));
  assert.equal(repository.snapshot.upstream, "origin/feature");
  assert.equal(repository.snapshot.ahead, 0);
});

/**
 * A working copy on a new branch `feature` with no Upstream, and a bare remote
 * for each name. No remote has the branch yet.
 * @param {string[]} names
 */
function unpublished(names) {
  const root = initRepo();
  /** @type {Record<string, string>} */
  const remotes = {};
  for (const name of names) {
    remotes[name] = bareRepo();
    git(root, "remote", "add", name, remotes[name]);
  }
  git(root, "switch", "-q", "-c", "feature");
  return { root, remotes };
}

/** The remotes (by name) that now have `feature`. @param {Record<string, string>} remotes */
const publishedTo = (remotes) =>
  Object.keys(remotes).filter((name) => git(remotes[name], "branch", "--list", "feature").trim() !== "");

test("Publish uses the branch's push remote first", async () => {
  const { root, remotes } = unpublished(["origin", "fork", "other"]);
  git(root, "config", "remote.pushDefault", "other");
  git(root, "config", "branch.feature.pushRemote", "fork");
  const repository = await follow(root);

  assert.deepEqual(await repository.sync("push"), { ok: true });
  assert.deepEqual(publishedTo(remotes), ["fork"]);
  assert.equal(repository.snapshot.upstream, "fork/feature");
});

test("Publish uses remote.pushDefault when the branch has no push remote", async () => {
  const { root, remotes } = unpublished(["origin", "other"]);
  git(root, "config", "remote.pushDefault", "other");
  const repository = await follow(root);

  assert.deepEqual(await repository.sync("push"), { ok: true });
  assert.deepEqual(publishedTo(remotes), ["other"]);
  assert.equal(repository.snapshot.upstream, "other/feature");
});

test("Publish uses the only remote, even when it isn't origin", async () => {
  const { root, remotes } = unpublished(["upstream"]);
  const repository = await follow(root);

  assert.deepEqual(await repository.sync("push"), { ok: true });
  assert.deepEqual(publishedTo(remotes), ["upstream"]);
  assert.equal(repository.snapshot.upstream, "upstream/feature");
});

test("Publish uses origin among several remotes with no push config", async () => {
  const { root, remotes } = unpublished(["fork", "origin"]);
  const repository = await follow(root);

  assert.deepEqual(await repository.sync("push"), { ok: true });
  assert.deepEqual(publishedTo(remotes), ["origin"]);
});

test("Publish with several remotes, no push config and no origin shows an error and pushes nowhere", async () => {
  const { root, remotes } = unpublished(["fork", "other"]);
  const repository = await follow(root);

  const result = await repository.sync("push");

  assert.equal(result.ok, false);
  assert.equal(result.error.summary, "Can't tell which remote to publish feature to. Set one with `git config remote.pushDefault <remote>`");
  assert.match(result.error.detail, /fork, other/);
  assert.deepEqual(repository.snapshot.lastError, result.error);
  assert.deepEqual(publishedTo(remotes), []);
  assert.equal(repository.snapshot.upstream, null);
});
