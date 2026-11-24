import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { cleanup, initRepo, git, write, tempDir } from "./helpers/repo.js";
import { createWorkbench } from "../src/core/workbench.js";
import { nodePlatform } from "../src/adapters/node-platform.js";

after(cleanup);

const MUTATING = new Set(["add", "restore", "reset"]);
/** The git subcommand in an argument list (after the standard flags). */
const subcommand = (args) => args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c");

/**
 * nodePlatform with every repository-changing git command recorded, and held
 * until `release()` when `hold` is on. Records the most that ran at once.
 */
function recordingPlatform() {
  const log = [];
  let inFlight = 0;
  let hold = false;
  /** @type {(() => void)[]} */
  let waiting = [];
  const rec = {
    log,
    maxInFlight: 0,
    hold() {
      hold = true;
    },
    release() {
      hold = false;
      for (const go of waiting.splice(0)) go();
    },
    /** Resolves once `n` commands are held. */
    async held(n = 1) {
      while (waiting.length < n) await new Promise((r) => setImmediate(r));
    },
    platform: {
      ...nodePlatform,
      async exec(cmd, args, opts) {
        const sub = subcommand(args);
        if (!MUTATING.has(sub)) return nodePlatform.exec(cmd, args, opts);
        inFlight++;
        rec.maxInFlight = Math.max(rec.maxInFlight, inFlight);
        try {
          if (hold) await new Promise((go) => waiting.push(go));
          log.push(`${sub} ${args.slice(args.indexOf("--") + 1).join(" ")} @${path.basename(opts.cwd)}`);
          return await nodePlatform.exec(cmd, args, opts);
        } finally {
          inFlight--;
        }
      },
    },
  };
  return rec;
}

test("concurrent actions run one at a time, in the order they were asked for", async () => {
  const root = initRepo({ files: { "a.txt": "a\n", "b.txt": "b\n" } });
  write(root, "a.txt", "a2\n");
  write(root, "b.txt", "b2\n");
  write(root, "c.txt", "c\n");
  const rec = recordingPlatform();
  const workbench = createWorkbench(rec.platform);
  await workbench.follow({ machine: null, folder: root });
  const { repository } = workbench.state;

  const results = await Promise.all([
    repository.stage(["a.txt"]),
    repository.stage(["b.txt"]),
    repository.unstage(["a.txt"]),
    repository.stage(["c.txt"]),
  ]);

  assert.ok(results.every((r) => r.ok));
  assert.equal(rec.maxInFlight, 1);
  const name = path.basename(root);
  assert.deepEqual(rec.log, [
    `add :(literal)a.txt @${name}`,
    `add :(literal)b.txt @${name}`,
    `restore :(literal)a.txt @${name}`,
    `add :(literal)c.txt @${name}`,
  ]);
  assert.deepEqual(git(root, "diff", "--cached", "--name-only").trim().split("\n"), ["b.txt", "c.txt"]);
});

test("the running entry's label appears in the snapshot and clears afterwards", async () => {
  const root = initRepo({ files: { "a.txt": "a\n" } });
  write(root, "a.txt", "a2\n");
  const rec = recordingPlatform();
  const workbench = createWorkbench(rec.platform);
  await workbench.follow({ machine: null, folder: root });
  const { repository } = workbench.state;
  const labels = [];
  repository.subscribe(() => labels.push(repository.snapshot.running?.label ?? null));

  rec.hold();
  const staging = repository.stage(["a.txt"]);
  await rec.held();
  assert.deepEqual(repository.snapshot.running, { label: "Staging…", timeoutClass: "short" });
  rec.release();
  await staging;
  await repository.unstage(["a.txt"]);

  assert.equal(repository.snapshot.running, null);
  assert.deepEqual(dedupe(labels), ["Staging…", null, "Unstaging…", null]);
});

const dedupe = (xs) => xs.filter((x, i) => i === 0 || x !== xs[i - 1]);

test("a Linked worktree shares the main repository's queue", async () => {
  const main = initRepo({ files: { "a.txt": "a\n" } });
  const wt = path.join(tempDir(), "wt");
  git(main, "worktree", "add", "-q", "-b", "side", wt);
  write(main, "a.txt", "main edit\n");
  write(wt, "a.txt", "worktree edit\n");
  const rec = recordingPlatform();
  const workbench = createWorkbench(rec.platform);
  await workbench.follow({ machine: null, folder: main });
  const inMain = workbench.state.repository;

  rec.hold();
  const mainStage = inMain.stage(["a.txt"]);
  await rec.held();
  await workbench.follow({ machine: null, folder: wt });
  const inWorktree = workbench.state.repository;
  assert.notEqual(inWorktree, inMain);
  assert.equal(inWorktree.snapshot.running?.label, "Staging…", "the worktree sees the main repository's running entry");

  const wtStage = inWorktree.stage(["a.txt"]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(rec.log.length, 0, "the worktree's command waits for the main repository's");
  rec.release();
  await Promise.all([mainStage, wtStage]);

  assert.equal(rec.maxInFlight, 1);
  assert.deepEqual(rec.log.map((l) => l.split(" @")[1]), [path.basename(main), "wt"]);
});

test("a Repository left while its queue is busy is disposed only once the queue drains", async () => {
  const a = initRepo({ files: { "a.txt": "a\n" } });
  const b = initRepo();
  write(a, "a.txt", "a2\n");
  const rec = recordingPlatform();
  const workbench = createWorkbench(rec.platform);
  await workbench.follow({ machine: null, folder: a });
  const first = workbench.state.repository;

  rec.hold();
  const staging = first.stage(["a.txt"]);
  await rec.held();
  await workbench.follow({ machine: null, folder: b });
  assert.equal(workbench.repository(first.key), undefined);
  assert.equal(first.disposed, false);

  rec.release();
  assert.deepEqual(await staging, { ok: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(first.disposed, true);
  assert.deepEqual(git(a, "diff", "--cached", "--name-only").trim(), "a.txt");
});

test("a Repository left with an idle queue is disposed", async () => {
  const workbench = createWorkbench(nodePlatform);
  await workbench.follow({ machine: null, folder: initRepo() });
  const first = workbench.state.repository;
  await workbench.follow({ machine: null, folder: initRepo() });
  await new Promise((r) => setImmediate(r));
  assert.equal(first.disposed, true);
});
