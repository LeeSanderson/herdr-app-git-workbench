// @ts-check
// Fetch and the shared sync machinery, at the Workbench seam, against a local
// bare repository as the remote (no network, no credential prompts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, remoteRepo, commitFile, git, initRepo, unauthorisedRemote } from "./helpers/repo.js";
import { createWorkbench } from "../src/core/workbench.js";
import { nodePlatform } from "../src/adapters/node-platform.js";
import { fakePlatform } from "./helpers/fake-platform.js";

after(cleanup);

/** @param {string} folder */
async function follow(folder, platform = nodePlatform) {
  const workbench = createWorkbench(platform);
  await workbench.follow({ machine: null, folder });
  assert.equal(workbench.state.kind, "ready");
  return /** @type {any} */ (workbench.state).repository;
}

const subjects = (graph) => (graph.state.kind === "ready" ? graph.state.commits.map((c) => c.subject) : graph.state.kind);

test("fetch brings in remote commits, updates the behind count and reloads the Graph", async () => {
  const { root, other } = remoteRepo();
  commitFile(other, "b.txt", "b\n", "Pushed by someone else");
  git(other, "push", "-q");
  const repository = await follow(root);
  await repository.graph.load();
  assert.equal(repository.snapshot.behind, 0);

  const result = await repository.sync("fetch");

  assert.deepEqual(result, { ok: true });
  assert.equal(repository.snapshot.behind, 1);
  assert.equal(repository.snapshot.lastError, null);
  assert.deepEqual(subjects(repository.graph), ["Pushed by someone else", "Initial"]);
});

test("a remote that needs credentials gives the sign-in message, with Git's error as the detail", async () => {
  const server = await unauthorisedRemote();
  try {
    const root = initRepo();
    git(root, "remote", "add", "origin", server.url);
    const repository = await follow(root);

    const result = await repository.sync("fetch");

    assert.equal(result.ok, false);
    assert.equal(result.error.summary, "Couldn't sign in to origin. Check your credentials (try `git fetch` in a terminal once)");
    assert.match(result.error.detail, /could not read Username/);
    assert.deepEqual(repository.snapshot.lastError, result.error);
  } finally {
    await server.close();
  }
});

/**
 * A fake platform whose `git fetch` hangs until `fail(err)` is called; other
 * git commands run for real.
 */
function hangingFetch() {
  const fake = fakePlatform();
  /** @type {(err: Error) => void} */
  let fail = () => {};
  const started = new Promise((onStart) => {
    fake.platform.exec = (cmd, args, opts) => {
      if (!args.includes("fetch")) return nodePlatform.exec(cmd, args, opts);
      onStart(undefined);
      return new Promise((_resolve, reject) => (fail = reject));
    };
  });
  return { fake, started, fail: (err) => fail(err) };
}

test("a running fetch says so, and adds the sign-in hint after about 15 s", async () => {
  const { fake, started, fail } = hangingFetch();
  const { root } = remoteRepo();
  const repository = await follow(root, fake.platform);

  const done = repository.sync("fetch");
  await started;
  assert.equal(repository.snapshot.running.label, "Fetching…");
  assert.deepEqual(fake.sleeps, [15_000]);

  await fake.tick();
  assert.equal(repository.snapshot.running.label, "Fetching… still waiting — a sign-in window may be open");

  fail(Object.assign(new Error("timed out"), { timedOut: true }));
  await done;
  assert.equal(repository.snapshot.running, null);
});

test("a fetch that times out says so, with Git's error as the detail", async () => {
  const { fake, started, fail } = hangingFetch();
  const { root } = remoteRepo();
  const repository = await follow(root, fake.platform);

  const done = repository.sync("fetch");
  await started;
  fail(Object.assign(new Error("timed out"), { timedOut: true }));
  const result = await done;

  assert.equal(result.ok, false);
  assert.equal(result.error.summary, "Fetch timed out after 10 min (sign-in not completed?)");
  assert.match(result.error.detail, /git fetch .*timed out after 600 s/);
  assert.deepEqual(repository.snapshot.lastError, result.error);
});

test("a failed fetch still refreshes status and reloads the Graph", async () => {
  const server = await unauthorisedRemote();
  try {
    // A fake platform: no file events arrive, so only the sync can refresh.
    const fake = fakePlatform();
    const { root } = remoteRepo();
    const repository = await follow(root, fake.platform);
    await repository.graph.load();
    commitFile(root, "c.txt", "c\n", "Made in a terminal");
    git(root, "remote", "set-url", "origin", server.url);

    const result = await repository.sync("fetch");

    assert.equal(result.ok, false);
    assert.equal(repository.snapshot.ahead, 1);
    assert.deepEqual(subjects(repository.graph), ["Made in a terminal", "Initial"]);
  } finally {
    await server.close();
  }
});
