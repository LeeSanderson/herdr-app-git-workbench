// @ts-check
// Fetch and the shared sync machinery, at the Workbench seam, against a local
// bare repository as the remote (no network, no credential prompts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, remoteRepo, commitFile, git, initRepo, unauthorisedRemote, silentRemote } from "./helpers/repo.js";
import { createWorkbench } from "../mods/herdr-app-git-workbench/src/core/workbench.js";
import { createGit } from "../mods/herdr-app-git-workbench/src/core/git.js";
import { runSync, SYNC_OPS } from "../mods/herdr-app-git-workbench/src/core/sync.js";
import { nodePlatform } from "./helpers/node-platform.js";
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
  assert.equal(repository.snapshot.running.sync, true, "a sync is marked, for its spinner");
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
  assert.equal(result.error.summary, "Fetch timed out after 10 min. Git may still be running (a sign-in window may be open)");
  assert.match(result.error.detail, /git fetch .*timed out after 600 s/);
  assert.match(result.error.detail, /may still be running/);
  assert.match(result.error.detail, /finishing sign-in lets the fetch complete/);
  assert.deepEqual(repository.snapshot.lastError, result.error);
});

test("a pull that times out warns that it may still merge or rebase", async () => {
  const fake = fakePlatform();
  fake.platform.exec = (cmd, args, opts) =>
    args.includes("pull")
      ? Promise.reject(Object.assign(new Error("timed out"), { timedOut: true }))
      : nodePlatform.exec(cmd, args, opts);
  const { root } = remoteRepo();
  const repository = await follow(root, fake.platform);

  const result = await repository.sync("pull");

  assert.equal(result.error.summary, "Pull timed out after 10 min. Git may still be running (a sign-in window may be open)");
  assert.match(result.error.detail, /finishing sign-in lets the pull complete, including its merge or rebase/);
});

/** A fake platform that records the arguments of every git command a test makes. */
function recordingPlatform() {
  const fake = fakePlatform();
  /** @type {string[][]} */
  const calls = [];
  fake.platform.exec = (cmd, args, opts) => {
    calls.push(args);
    return nodePlatform.exec(cmd, args, opts);
  };
  return { platform: fake.platform, calls };
}

const STALL_FLAGS = ["-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=120"];
/** Does `args` contain `flags` in order? */
const hasRun = (args, flags) => args.some((_, i) => flags.every((f, j) => args[i + j] === f));

test("a sync's Git commands give up on a remote that sends nothing for 2 min", async () => {
  const { platform, calls } = recordingPlatform();
  const { root } = remoteRepo();
  const repository = await follow(root, platform);

  await repository.sync("fetch");

  const fetch = calls.find((args) => args.includes("fetch"));
  assert.ok(fetch && hasRun(fetch, STALL_FLAGS), `fetch args: ${fetch}`);
});

test("a sync keeps the user's own HTTP stall settings", async () => {
  const { platform, calls } = recordingPlatform();
  const { root } = remoteRepo();
  git(root, "config", "http.lowSpeedTime", "30");
  const repository = await follow(root, platform);

  await repository.sync("fetch");

  const fetch = calls.find((args) => args.includes("fetch"));
  assert.ok(fetch && !fetch.some((a) => a.startsWith("http.lowSpeed")), `fetch args: ${fetch}`);
});

test("a fetch from a remote that never answers stops as stalled, naming the remote", async () => {
  const server = await silentRemote();
  try {
    const root = initRepo();
    git(root, "remote", "add", "origin", server.url);
    const deps = {
      git: createGit(nodePlatform), machine: null, cwd: root, timeoutClass: /** @type {const} */ ("long"),
      sleep: () => new Promise(() => {}), relabel: () => {}, stallSeconds: 2,
    };

    const error = await runSync(deps, SYNC_OPS.fetch, {});

    assert.equal(error?.summary, "Fetch stalled: origin sent nothing for 2 s. Check your connection, then try again");
    assert.match(error?.detail ?? "", /Operation too slow/);
  } finally {
    await server.close();
  }
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
