// @ts-check
// A Repository: one followed Git repository, keyed by {machine, toplevel}.
// Created and owned by the Workbench.

import { parseStatus } from "./status.js";
import { watchLabel, watchRoots } from "./watch-filter.js";
import { repositoryKey, repositoryId } from "./repository-key.js";
import { actionError, errorFrom, messageOf, outputOf } from "./errors.js";
import { createSignal, coalesce } from "./signal.js";
import { createGraph } from "./graph.js";
import { SYNC_OPS, runSync } from "./sync.js";

/** Quiet time after the last relevant file event before refreshing. */
export const DEBOUNCE_MS = 400;

/** @typedef {ReturnType<import("./git.js").createGit>} Git */
/** @typedef {import("./git.js").TimeoutClass} TimeoutClass */
/** @typedef {import("./repository-key.js").RepositoryKey} RepositoryKey */
/** @typedef {import("./errors.js").ActionError} ActionError */
/** @typedef {"merge" | "rebase" | "cherry-pick" | "revert" | "none"} Operation */
/** @typedef {{ ok: boolean, error?: ActionError }} ActionResult */
/**
 * @typedef {Readonly<{
 *   branch: string | null,
 *   headOid: string | null,
 *   unborn: boolean,
 *   detached: boolean,
 *   upstream: string | null,
 *   ahead: number | null,
 *   behind: number | null,
 *   operation: Operation,
 *   groups: import("./status.js").ChangeGroups,
 *   running: import("./queue.js").QueueEntry | null,
 *   lastError: ActionError | null,
 *   watchError: string | null,
 * }>} Snapshot
 */

/**
 * Pathspecs for `paths`, taken literally (no glob or magic), in batches that keep
 * one command line well under Windows' 32 767-character limit.
 * @param {string[]} paths
 */
function pathspecBatches(paths) {
  const LIMIT = 24_000;
  /** @type {string[][]} */
  const batches = [];
  /** @type {string[]} */
  let batch = [];
  let size = 0;
  for (const p of paths) {
    const spec = `:(literal)${p}`;
    if (batch.length && size + spec.length + 3 > LIMIT) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(spec);
    size += spec.length + 3;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * Files in the real (per-worktree) git dir that mark an Operation in progress, checked in order.
 * A rebase is checked first: it can leave other markers behind while it runs. For the
 * rebase folders we read `head-name`, which `git am` (also using rebase-apply/) doesn't write.
 * @type {[string, Operation][]}
 */
const OPERATION_MARKERS = [
  ["rebase-merge/head-name", "rebase"],
  ["rebase-apply/head-name", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
];

/**
 * The Operation in progress in `gitDir`, read from its marker files.
 * @param {ReadTextFile} readTextFile @param {string | null} machine @param {string} gitDir
 * @returns {Promise<Operation>}
 */
async function readOperation(readTextFile, machine, gitDir) {
  const dir = gitDir.replace(/[\\/]+$/, "");
  const found = await Promise.all(OPERATION_MARKERS.map(([file]) =>
    readTextFile(`${dir}/${file}`, { on: machine }).then((text) => text !== null, () => false)));
  const at = found.indexOf(true);
  return at < 0 ? "none" : OPERATION_MARKERS[at][1];
}

/** @typedef {import("./platform.js").Platform["readTextFile"]} ReadTextFile */

/**
 * @param {{ git: Git, key: RepositoryKey, queue: import("./queue.js").Queue, platform: import("./platform.js").Platform, dirs: import("./watch-filter.js").RepositoryDirs }} deps
 *   `queue` is shared by every Repository with the same common git dir. `dirs` are the
 *   absolute working tree, real git dir (per worktree, where the Operation in progress
 *   is read) and common dir. The Repository watches them until `dispose()`,
 *   refreshing (debounced) on relevant events.
 */
export function createRepository({ git, key, queue, platform, dirs }) {
  key = repositoryKey(key);
  /** @type {(ReturnType<typeof parseStatus> & { operation: Operation }) | null} */
  let status = null;
  /** @type {Snapshot | null} */
  let snapshot = null;
  /** @type {ActionError | null} */
  let lastError = null;
  /** Why the file watch stopped, or null while it runs. @type {string | null} */
  let watchError = null;
  let disposed = false;
  const changes = createSignal();
  /** The history beside the Change groups. Its loads skip the queue (see graph.js). */
  const graph = createGraph({ git, key, status: () => status, settings: platform });

  /** Reloads the Graph if it has loaded once and the Repository is still followed; never rejects. */
  function reloadGraph() {
    return graph.started && !disposed ? graph.load() : Promise.resolve();
  }

  /** Rebuilds the snapshot from the latest status, the queue and lastError, and tells listeners. */
  function publish() {
    if (!status) return;
    snapshot = Object.freeze({ ...status, running: queue.running, lastError, watchError });
    changes.emit();
  }
  const offQueue = queue.subscribe(publish);

  /** Re-reads the repository from Git. @returns {Promise<ActionResult>} */
  async function readStatus() {
    const [r, operation] = await Promise.all([
      git.run(key.machine, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"], { cwd: key.toplevel, read: true }),
      readOperation(platform.readTextFile, key.machine, dirs.gitDir),
    ]);
    if (!r.ok) return { ok: false, error: actionError(r.stderr, "git status failed") };
    if (disposed) return { ok: true };
    status = { ...parseStatus(r.stdout), operation };
    publish();
    return { ok: true };
  }

  /** A refresh requested while one runs merges into a single follow-up. */
  const refresh = coalesce(readStatus);

  // Debounce: refresh once relevant events have been quiet for DEBOUNCE_MS. A
  // batch with a `refs` path in the quiet period also reloads a loaded Graph,
  // after the status read (Auto's revisions depend on the Upstream).
  let eventSeq = 0;
  let debouncing = false;
  let refsMoved = false;
  /** @param {boolean} refs */
  async function schedule(refs) {
    eventSeq++;
    refsMoved ||= refs;
    if (debouncing) return;
    debouncing = true;
    try {
      let seen;
      do {
        seen = eventSeq;
        await platform.sleep(DEBOUNCE_MS);
      } while (seen !== eventSeq && !disposed);
    } finally {
      debouncing = false;
    }
    if (disposed) return;
    const moved = refsMoved;
    refsMoved = false;
    await refresh().catch(() => {});
    if (moved) await reloadGraph();
  }

  /** @type {import("./platform.js").Watch[]} */
  const watches = [];
  for (const dir of watchRoots(dirs)) {
    const w = platform.watch(dir);
    watches.push(w);
    (async () => {
      for await (const batch of w.events) {
        if (disposed) return;
        const labels = batch.map((p) => watchLabel(p, dirs));
        if (labels.some(Boolean)) void schedule(labels.includes("refs"));
      }
    })().catch((err) => {
      // The watch stopped (e.g. Herdr's 64-folder limit). Say so; refreshes
      // still come from actions, focus and the refresh button.
      if (disposed) return;
      watchError = messageOf(err);
      publish();
    });
  }

  /**
   * Runs one repository-changing command through the queue, then refreshes.
   * Sets `lastError` on failure and clears it on success.
   * @param {string} label shown in `snapshot.running`
   * @param {TimeoutClass} timeoutClass
   * @param {(timeoutClass: TimeoutClass, relabel: (label: string) => void) => Promise<ActionError | null>} command
   *   `relabel` changes the label while it runs.
   * @returns {Promise<ActionResult>}
   */
  async function act(label, timeoutClass, command) {
    const error = await queue.run({ label, timeoutClass }, async (entry, relabel) => {
      /** @type {ActionError | null} */
      let error;
      try {
        error = await command(entry.timeoutClass, relabel);
      } catch (err) {
        // GitNotFound / GitTimeout
        error = errorFrom(err);
      }
      lastError = error;
      await self.refresh();
      return error;
    });
    return error ? { ok: false, error } : { ok: true };
  }

  /**
   * Runs `git <args> -- <paths>` in batches, stopping at the first failure.
   * @param {string[]} args @param {string[]} paths @param {TimeoutClass} timeoutClass
   * @returns {Promise<ActionError | null>}
   */
  async function runOnPaths(args, paths, timeoutClass) {
    for (const batch of pathspecBatches(paths)) {
      const r = await git.run(key.machine, [...args, "--", ...batch], { cwd: key.toplevel, timeoutClass });
      if (!r.ok) return actionError(r.stderr, `git ${args[0]} failed`);
    }
    return null;
  }

  const self = {
    key,
    id: repositoryId(key),

    /** The latest snapshot; null until the first refresh completes. */
    get snapshot() {
      return snapshot;
    },

    /** Called after every snapshot change. @param {() => void} fn @returns {() => void} */
    subscribe: changes.subscribe,

    /** Re-reads the repository from Git; a call while one runs merges into a single follow-up. */
    refresh,

    /** The Graph: history from HEAD with its lane layout. Nothing loads until `graph.load()`. */
    graph,

    /**
     * Stages `paths` (relative to the top level) with `git add`, which also adds
     * untracked files and marks a Conflict resolved.
     * @param {string[]} paths @returns {Promise<ActionResult>}
     */
    stage(paths) {
      if (!paths.length) return Promise.resolve({ ok: true });
      return act("Staging…", "short", (timeoutClass) => runOnPaths(["add"], paths, timeoutClass));
    },

    /**
     * Unstages `paths`: `git restore --staged`, or `git reset` on an unborn branch,
     * where restore fails because HEAD can't be resolved. (Spec #19 names only
     * `restore --staged`; `git reset -q -- <paths>` is the documented way to
     * unstage before the first commit, removing the paths from the index.)
     * For a staged rename, pass both `path` and `oldPath`.
     * @param {string[]} paths @returns {Promise<ActionResult>}
     */
    unstage(paths) {
      if (!paths.length) return Promise.resolve({ ok: true });
      return act("Unstaging…", "short", (timeoutClass) =>
        runOnPaths(snapshot?.unborn ? ["reset", "-q"] : ["restore", "--staged"], paths, timeoutClass));
    },

    /**
     * Commits what is staged with `message` as one `-m` argument, so Git sees it
     * exactly as typed. Hooks run as on the command line; a failure's `detail` is
     * Git's full output, hook output included. Runs with the long timeout.
     * `amend: true` adds `--amend` (Phase 2; the Phase 1 UI never passes it).
     * @param {{ message: string, amend?: boolean }} options @returns {Promise<ActionResult>}
     */
    async commit({ message, amend = false }) {
      const result = await act("Committing…", "long", async (timeoutClass) => {
        const args = ["commit", ...(amend ? ["--amend"] : []), "-m", message];
        const r = await git.run(key.machine, args, { cwd: key.toplevel, timeoutClass });
        // Hooks write to stderr; Git's own refusals ("nothing to commit") go to stdout.
        return r.ok ? null : actionError(outputOf(r), "git commit failed");
      });
      // The new commit shows straight away; the reload runs beside the queue.
      if (result.ok) void reloadGraph();
      return result;
    },

    /**
     * Throws away the working-tree changes to `paths`: tracked files are restored
     * from the index (`git restore --worktree`), untracked ones are removed. It
     * does not ask for confirmation; the panel does that first.
     * @param {string[]} paths @returns {Promise<ActionResult>}
     */
    discard(paths) {
      if (!paths.length) return Promise.resolve({ ok: true });
      return act("Discarding…", "short", async (timeoutClass) => {
        // Sorted by the snapshot current when the queue reaches this entry.
        const untracked = new Set(snapshot?.groups.untracked.map((c) => c.path) ?? []);
        const tracked = paths.filter((p) => !untracked.has(p));
        const untrackedPaths = paths.filter((p) => untracked.has(p));
        if (tracked.length) {
          const error = await runOnPaths(["restore", "--worktree"], tracked, timeoutClass);
          if (error) return error;
        }
        // `clean` without -d/-x removes only these untracked files, never ignored ones.
        if (untrackedPaths.length) return runOnPaths(["clean", "-f", "-q"], untrackedPaths, timeoutClass);
        return null;
      });
    },

    /**
     * Runs a sync (`"fetch"`, `"pull"`, `"push"`) on the queue with the long timeout. A failure is
     * classified into one message, with Git's full output as its detail. Successful
     * or not, it then refreshes status and reloads a loaded Graph (keeping its state).
     * @param {import("./sync.js").SyncName} name @param {Record<string, unknown>} [options]
     * @returns {Promise<ActionResult>}
     */
    async sync(name, options = {}) {
      const op = SYNC_OPS[name];
      if (!op) throw new Error(`Unknown sync: ${name}`);
      const result = await act(op.running, "long", (timeoutClass, relabel) =>
        runSync({ git, machine: key.machine, cwd: key.toplevel, timeoutClass, sleep: platform.sleep, relabel }, op, options));
      await reloadGraph();
      return result;
    },

    /** True once the Workbench has let go of this Repository and its queue has drained. */
    get disposed() {
      return disposed;
    },

    /** Stops watching, listening and notifying. The Workbench calls it once the queue drains. */
    dispose() {
      disposed = true;
      for (const w of watches.splice(0)) w.cancel();
      offQueue();
      graph.dispose();
      changes.clear();
    },
  };
  return self;
}

/** @typedef {ReturnType<typeof createRepository>} Repository */
