import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, initRepo, write, lines, tempDir } from "./helpers/repo.js";
import { createWorkbench } from "../mods/herdr-app-git-workbench/src/core/workbench.js";
import { nodePlatform } from "./helpers/node-platform.js";
import { diffTargetFor } from "../mods/herdr-app-git-workbench/src/core/diff-target.js";
import { createLiveDiff } from "../mods/herdr-app-git-workbench/src/core/live-diff.js";

after(cleanup);

/** nodePlatform without file watching: tests drive refreshes by hand. */
const platform = { ...nodePlatform, watch: () => ({ events: (async function* () {})(), cancel() {} }) };

/** Follows a fresh repository with a.txt edited; returns the Workbench, its Repository and a.txt's Diff target. */
async function setup() {
  const root = initRepo({ files: { "a.txt": lines(["one", "two"]) } });
  write(root, "a.txt", lines(["one", "TWO"]));
  const workbench = createWorkbench(platform);
  await workbench.follow({ machine: null, folder: root });
  const repository = workbench.state.repository;
  const change = repository.snapshot.groups.changes.find((c) => c.path === "a.txt");
  return { root, workbench, repository, target: diffTargetFor(repository.key, change) };
}

/** Wraps a Workbench so the test sees every loadDiff call and can hold them. */
function counting(workbench) {
  const calls = { started: 0, inFlight: 0, maxInFlight: 0 };
  return {
    calls,
    repository: (key) => workbench.repository(key),
    subscribe: (fn) => workbench.subscribe(fn),
    async loadDiff(target) {
      calls.started++;
      calls.maxInFlight = Math.max(calls.maxInFlight, ++calls.inFlight);
      try {
        return await workbench.loadDiff(target);
      } finally {
        calls.inFlight--;
      }
    },
  };
}

/** Resolves once `live` reports a change that `ok()` accepts (or fails after ~10 s). */
function until(live, ok) {
  return new Promise((resolve, reject) => {
    if (ok()) return resolve();
    const timer = setTimeout(() => { off(); reject(new Error("timed out")); }, 10_000);
    const off = live.onChange(() => {
      if (ok()) { clearTimeout(timer); off(); resolve(); }
    });
  });
}

const rightTexts = (doc) => doc.rows("split").map((r) => r.right?.text);

test("an open Diff view loads, then reloads when the Repository's snapshot changes", async () => {
  const { root, workbench, repository, target } = await setup();
  const live = createLiveDiff(workbench, target);
  await until(live, () => live.doc !== null);
  assert.deepEqual(rightTexts(live.doc), ["one", "TWO"]);

  write(root, "a.txt", lines(["one", "TWO", "three"]));
  await repository.refresh();
  await until(live, () => live.doc.rows("split").length === 3);
  assert.deepEqual(rightTexts(live.doc), ["one", "TWO", "three"]);
  assert.equal(live.stale, false);
  live.dispose();
});

test("reloads asked for while one runs merge into a single follow-up", async () => {
  const { root, workbench, target } = await setup();
  const source = counting(workbench);
  const live = createLiveDiff(source, target);
  await until(live, () => live.doc !== null);
  assert.equal(source.calls.started, 1);

  const first = live.reload();
  write(root, "a.txt", lines(["one", "TWO", "three"]));
  const merged = [live.reload(), live.reload(), live.reload()];
  await Promise.all([first, ...merged]);
  await until(live, () => !live.loading);

  assert.equal(source.calls.maxInFlight, 1, "never two loads at once");
  assert.equal(source.calls.started, 3, "the first load, the forced one, one merged follow-up");
  assert.deepEqual(rightTexts(live.doc), ["one", "TWO", "three"], "the follow-up saw the last edit");
  live.dispose();
});

test("a burst of snapshot changes loads one at a time and ends current", async () => {
  const { root, workbench, repository, target } = await setup();
  const source = counting(workbench);
  const live = createLiveDiff(source, target);
  await until(live, () => live.doc !== null);

  write(root, "a.txt", lines(["one", "TWO", "four"]));
  await Promise.all([repository.refresh(), repository.refresh(), repository.refresh()]);
  await until(live, () => !live.loading && live.doc.rows("split").length === 3);
  assert.equal(source.calls.maxInFlight, 1);
  assert.ok(source.calls.started <= 3, `loads: ${source.calls.started}`);
  live.dispose();
});

test("when the Repository is no longer followed, the last document stays and is stale", async () => {
  const { root, workbench, repository, target } = await setup();
  const live = createLiveDiff(workbench, target);
  await until(live, () => live.doc !== null);
  const last = live.doc;

  await workbench.follow({ machine: null, folder: initRepo() });
  await until(live, () => live.stale);
  assert.equal(live.doc, last, "keeps its last document");

  // Edits now don't reach it: the old Repository is disposed.
  write(root, "a.txt", lines(["one", "TWO", "gone"]));
  await repository.refresh();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(live.doc, last);

  // Coming back follows it live again and catches up.
  await workbench.follow({ machine: null, folder: root });
  await until(live, () => !live.stale && live.doc.rows("split").length === 3);
  assert.deepEqual(rightTexts(live.doc), ["one", "TWO", "gone"]);
  live.dispose();
});

test("a Diff view opened for a Repository that isn't followed loads once and is stale", async () => {
  const { target } = await setup();
  const other = createWorkbench(platform);
  await other.follow({ machine: null, folder: tempDir() });
  const live = createLiveDiff(other, target);
  await until(live, () => live.doc !== null);
  assert.equal(live.stale, true);
  assert.deepEqual(rightTexts(live.doc), ["one", "TWO"]);
  live.dispose();
});
