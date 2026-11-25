import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { cleanup, initRepo, git, write, samePath, tempDir } from "./helpers/repo.js";
import { createWorkbench } from "../src/core/workbench.js";
import { nodePlatform } from "../src/adapters/node-platform.js";

after(cleanup);

/** Lets pending promise chains and I/O callbacks run. */
const settle = () => new Promise((r) => setImmediate(r));

/**
 * A platform with a hand-fired `watch` and a hand-advanced `sleep`; everything
 * else is real. `watches` records every watch made: `{path, fire(paths), cancelled}`.
 */
function fakePlatform() {
  /** @type {{ path: string, fire(paths: string[]): void, fail(err: Error): void, cancelled: boolean }[]} */
  const watches = [];
  /** @type {(() => void)[]} */
  const sleepers = [];
  const platform = {
    ...nodePlatform,
    watch(dir) {
      const queue = [];
      let wake = null;
      let failure = null;
      const w = {
        path: dir,
        cancelled: false,
        fire(paths) {
          queue.push(paths);
          wake?.();
        },
        /** Makes the watch reject, as watchFolder does past its folder limit. */
        fail(err) {
          failure = err;
          wake?.();
        },
      };
      watches.push(w);
      return {
        events: (async function* () {
          while (!w.cancelled) {
            if (!queue.length && !failure) await new Promise((r) => (wake = r));
            wake = null;
            if (failure) throw failure;
            while (queue.length && !w.cancelled) yield queue.shift();
          }
        })(),
        cancel() {
          w.cancelled = true;
          wake?.();
        },
      };
    },
    sleep: () => new Promise((r) => sleepers.push(r)),
  };
  return {
    platform,
    watches,
    /** Sleeps waiting to be woken. */
    get sleeping() {
      return sleepers.length;
    },
    /** Wakes every pending sleep, then lets the core run on. */
    async tick() {
      for (const r of sleepers.splice(0)) r();
      await settle();
    },
  };
}

/** Follows `folder` and counts the Repository's refreshes from then on. */
async function followCounting(fake, folder) {
  const workbench = createWorkbench(fake.platform);
  await workbench.follow({ machine: null, folder });
  const repository = workbench.state.repository;
  const counter = { workbench, repository, refreshes: 0, next: null };
  let resolveNext;
  counter.next = new Promise((r) => (resolveNext = r));
  repository.subscribe(() => {
    counter.refreshes++;
    resolveNext();
    counter.next = new Promise((r) => (resolveNext = r));
  });
  return counter;
}

/** Ticks the fake clock until a refresh lands (or gives up after ~15 s; git is slow on a busy machine). */
async function untilRefreshed(fake, counter) {
  const before = counter.refreshes;
  for (let i = 0; i < 300 && counter.refreshes === before; i++) {
    await fake.tick();
    await Promise.race([counter.next, new Promise((r) => setTimeout(r, 50))]);
  }
}

/** Ticks a few times and waits a little, so anything scheduled would have run. */
async function quiet(fake) {
  for (let i = 0; i < 5; i++) {
    await fake.tick();
    await new Promise((r) => setTimeout(r, 20));
  }
}

const watchOf = (fake, dir) => fake.watches.find((w) => samePath(w.path, dir) && !w.cancelled);

test("a file edited in the working tree refreshes the panel", async () => {
  const fake = fakePlatform();
  const root = initRepo();
  const counter = await followCounting(fake, root);
  assert.deepEqual(counter.repository.snapshot.groups.changes, []);

  write(root, "README.md", "edited\n");
  watchOf(fake, root).fire([path.join(root, "README.md")]);
  await untilRefreshed(fake, counter);

  assert.equal(counter.refreshes, 1);
  assert.deepEqual(counter.repository.snapshot.groups.changes.map((c) => c.path), ["README.md"]);
});

// Herdr's watchFolder on Windows reports verbatim paths (`\\?\C:\...`) while Git
// prints `C:/...`: seen in the running app, where no edit ever refreshed the panel.
test("an event path in Windows' verbatim form (\\\\?\\C:\\...) refreshes the panel", { skip: process.platform !== "win32" }, async () => {
  const fake = fakePlatform();
  const root = initRepo();
  const counter = await followCounting(fake, root);

  write(root, "README.md", "edited\n");
  watchOf(fake, root).fire([`\\\\?\\${path.join(root, "README.md")}`]);
  await untilRefreshed(fake, counter);

  assert.equal(counter.refreshes, 1);
  assert.deepEqual(counter.repository.snapshot.groups.changes.map((c) => c.path), ["README.md"]);
});

test("a watch that fails is reported in the snapshot, not swallowed", async () => {
  const fake = fakePlatform();
  const root = initRepo();
  const counter = await followCounting(fake, root);
  assert.equal(counter.repository.snapshot.watchError, null);

  watchOf(fake, root).fail(new Error("too many folders are being watched"));
  await untilRefreshed(fake, counter);

  assert.match(counter.repository.snapshot.watchError, /too many folders/);
});

test("Git commands run in a terminal refresh the panel through the git dir", async () => {
  const fake = fakePlatform();
  const root = initRepo();
  const counter = await followCounting(fake, root);
  const gitDir = path.join(root, ".git");

  git(root, "checkout", "-q", "-b", "topic");
  watchOf(fake, root).fire([path.join(gitDir, "HEAD")]);
  await untilRefreshed(fake, counter);
  assert.equal(counter.repository.snapshot.branch, "topic");

  for (const rel of ["index", "MERGE_HEAD", "rebase-merge/head-name", "refs/heads/topic", "packed-refs"]) {
    const before = counter.refreshes;
    watchOf(fake, root).fire([path.join(gitDir, rel)]);
    await untilRefreshed(fake, counter);
    assert.equal(counter.refreshes, before + 1, rel);
  }
});

test("events in the git dir outside the allowlist are ignored", async () => {
  const fake = fakePlatform();
  const root = initRepo();
  const counter = await followCounting(fake, root);
  const gitDir = path.join(root, ".git");

  watchOf(fake, root).fire([
    path.join(gitDir, "index.lock"),
    path.join(gitDir, "objects", "ab", "cdef"),
    path.join(gitDir, "logs", "HEAD"),
    path.join(gitDir, "FETCH_HEAD"),
  ]);
  await quiet(fake);
  assert.equal(counter.refreshes, 0);
});

test("a burst of events debounces into one refresh", async () => {
  const fake = fakePlatform();
  const root = initRepo();
  const counter = await followCounting(fake, root);

  for (let i = 0; i < 5; i++) {
    watchOf(fake, root).fire([path.join(root, `f${i}.txt`)]);
    await settle();
    if (i % 2) await fake.tick(); // part-way through the quiet period
  }
  await untilRefreshed(fake, counter);
  await quiet(fake);
  assert.equal(counter.refreshes, 1);
});

test("refreshes requested while one runs merge into a single follow-up", async () => {
  const fake = fakePlatform();
  const root = initRepo();
  const counter = await followCounting(fake, root);

  const first = counter.repository.refresh();
  write(root, "new.txt", "x\n");
  const merged = [counter.repository.refresh(), counter.repository.refresh(), counter.repository.refresh()];
  await Promise.all([first, ...merged]);

  assert.equal(counter.refreshes, 2);
  assert.deepEqual(counter.repository.snapshot.groups.untracked.map((c) => c.path), ["new.txt"]);
});

test("a linked worktree watches its own git dir and ignores other worktrees", async () => {
  const fake = fakePlatform();
  const main = initRepo();
  const wt = path.join(tempDir(), "wt");
  git(main, "worktree", "add", "-q", "-b", "wt-branch", wt);
  const other = path.join(tempDir(), "other");
  git(main, "worktree", "add", "-q", "-b", "other-branch", other);
  const common = path.join(main, ".git");

  const counter = await followCounting(fake, wt);
  assert.equal(counter.repository.snapshot.branch, "wt-branch");
  const commonWatch = watchOf(fake, common);
  assert.ok(watchOf(fake, wt), "watches the worktree");
  assert.ok(commonWatch, "watches the common dir (which holds this worktree's git dir)");

  for (const p of [path.join(common, "worktrees", "other", "index"), path.join(common, "index"), path.join(common, "HEAD")]) {
    commonWatch.fire([p]);
  }
  await quiet(fake);
  assert.equal(counter.refreshes, 0, "other worktrees' files don't refresh");

  git(wt, "checkout", "-q", "-b", "wt-moved");
  commonWatch.fire([path.join(common, "worktrees", "wt", "HEAD")]);
  await untilRefreshed(fake, counter);
  assert.equal(counter.repository.snapshot.branch, "wt-moved");

  commonWatch.fire([path.join(common, "refs", "heads", "main")]);
  await untilRefreshed(fake, counter);
  assert.equal(counter.refreshes, 2, "shared refs refresh every worktree");
});

test("moving away stops the old watch; coming back resolves the Repository afresh", async () => {
  const fake = fakePlatform();
  const a = initRepo({ branch: "a" });
  const b = initRepo({ branch: "b" });
  const counter = await followCounting(fake, a);
  const oldWatch = watchOf(fake, a);
  const { workbench } = counter;

  await workbench.follow({ machine: null, folder: b });
  assert.equal(oldWatch.cancelled, true);
  oldWatch.fire([path.join(a, "x.txt")]);
  await quiet(fake);
  assert.equal(counter.refreshes, 0);

  await workbench.follow({ machine: null, folder: a });
  const again = workbench.state.repository;
  assert.notEqual(again, counter.repository);
  assert.equal(again.snapshot.branch, "a");
  assert.ok(watchOf(fake, a), "watching again");
});

test("a pending debounced refresh is dropped when the Repository is left", async () => {
  const fake = fakePlatform();
  const a = initRepo();
  const counter = await followCounting(fake, a);
  watchOf(fake, a).fire([path.join(a, "x.txt")]);
  await settle();
  await counter.workbench.follow({ machine: null, folder: tempDir() });
  await quiet(fake);
  assert.equal(counter.refreshes, 0);
});
