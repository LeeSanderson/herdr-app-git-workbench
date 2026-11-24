// @ts-check
// A Repository: one followed Git repository, keyed by {machine, toplevel}.
// Created and owned by the Workbench.

import { parseStatus } from "./status.js";
import { createQueue } from "./queue.js";
import { isRelevant, watchRoots } from "./watch-filter.js";

/** Quiet time after the last relevant file event before refreshing. */
export const DEBOUNCE_MS = 400;

/** @typedef {ReturnType<import("./git.js").createGit>} Git */
/** @typedef {import("./git.js").TimeoutClass} TimeoutClass */
/** @typedef {{ machine: string | null, toplevel: string }} RepositoryKey */
/** @typedef {{ summary: string, detail: string }} ActionError */
/** @typedef {{ ok: boolean, error?: ActionError }} ActionResult */
/**
 * @typedef {Readonly<{
 *   branch: string | null,
 *   headOid: string | null,
 *   unborn: boolean,
 *   detached: boolean,
 *   groups: import("./status.js").ChangeGroups,
 *   running: import("./queue.js").QueueEntry | null,
 *   lastError: ActionError | null,
 * }>} Snapshot
 */

/**
 * Stable string form of a Repository key, for registries and plain-JSON props.
 * @param {RepositoryKey | string} key
 */
export function repositoryId(key) {
  return typeof key === "string" ? key : JSON.stringify([key.machine ?? null, key.toplevel]);
}

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

/** @param {string} stderr @param {string} fallback @returns {ActionError} */
function errorFrom(stderr, fallback) {
  const detail = stderr.trim();
  const first = detail.split("\n").find((l) => l.trim()) ?? "";
  return { summary: first.trim() || fallback, detail: detail || fallback };
}

/**
 * With `platform` and `dirs`, the Repository watches its working tree and git
 * dirs until `dispose()`, refreshing (debounced) on relevant events.
 * @param {{ git: Git, key: RepositoryKey, queue?: import("./queue.js").Queue, platform?: import("./platform.js").Platform, dirs?: import("./watch-filter.js").RepositoryDirs }} deps
 *   `queue` is shared by every Repository with the same common git dir.
 */
export function createRepository({ git, key, queue = createQueue(), platform, dirs }) {
  key = Object.freeze({ machine: key.machine ?? null, toplevel: key.toplevel });
  /** @type {ReturnType<typeof parseStatus> | null} */
  let status = null;
  /** @type {Snapshot | null} */
  let snapshot = null;
  /** @type {ActionError | null} */
  let lastError = null;
  let disposed = false;
  /** @type {Set<() => void>} */
  const listeners = new Set();

  /** Rebuilds the snapshot from the latest status, the queue and lastError, and tells listeners. */
  function publish() {
    if (!status) return;
    snapshot = Object.freeze({ ...status, running: queue.running, lastError });
    for (const fn of [...listeners]) fn();
  }
  const offQueue = queue.subscribe(publish);

  /** Re-reads the repository from Git. @returns {Promise<ActionResult>} */
  async function readStatus() {
    const r = await git.run(key.machine, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"], { cwd: key.toplevel, read: true });
    if (!r.ok) return { ok: false, error: errorFrom(r.stderr, "git status failed") };
    if (disposed) return { ok: true };
    status = parseStatus(r.stdout);
    publish();
    return { ok: true };
  }

  // A refresh requested while one runs merges into a single follow-up.
  /** @type {Promise<ActionResult> | null} */
  let running = null;
  /** @type {Promise<ActionResult> | null} */
  let followUp = null;
  /** @returns {Promise<ActionResult>} */
  function refresh() {
    if (!running) {
      running = readStatus().finally(() => {
        running = null;
      });
      return running;
    }
    if (!followUp) {
      const next = () => {
        followUp = null;
        return refresh();
      };
      followUp = running.then(next, next);
    }
    return followUp;
  }

  // Debounce: refresh once relevant events have been quiet for DEBOUNCE_MS.
  let eventSeq = 0;
  let debouncing = false;
  async function schedule() {
    eventSeq++;
    if (debouncing) return;
    debouncing = true;
    try {
      let seen;
      do {
        seen = eventSeq;
        await /** @type {import("./platform.js").Platform} */ (platform).sleep(DEBOUNCE_MS);
      } while (seen !== eventSeq && !disposed);
    } finally {
      debouncing = false;
    }
    if (!disposed) refresh().catch(() => {});
  }

  /** @type {import("./platform.js").Watch[]} */
  const watches = [];
  if (platform && dirs) {
    for (const dir of watchRoots(dirs)) {
      const w = platform.watch(dir);
      watches.push(w);
      (async () => {
        for await (const batch of w.events) {
          if (disposed) return;
          if (batch.some((p) => isRelevant(p, dirs))) schedule();
        }
      })().catch(() => {});
    }
  }

  /**
   * Runs one repository-changing command through the queue, then refreshes.
   * Sets `lastError` on failure and clears it on success.
   * @param {string} label shown in `snapshot.running`
   * @param {TimeoutClass} timeoutClass
   * @param {(timeoutClass: TimeoutClass) => Promise<ActionError | null>} command
   * @returns {Promise<ActionResult>}
   */
  async function act(label, timeoutClass, command) {
    const error = await queue.run({ label, timeoutClass }, async (entry) => {
      /** @type {ActionError | null} */
      let error;
      try {
        error = await command(entry.timeoutClass);
      } catch (err) {
        // GitNotFound / GitTimeout
        const message = String(err?.message ?? err);
        error = { summary: message, detail: message };
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
      if (!r.ok) return errorFrom(r.stderr, `git ${args[0]} failed`);
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

    /** @param {() => void} fn @returns {() => void} */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Re-reads the repository from Git; a call while one runs merges into a single follow-up. */
    refresh,

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
     * where restore fails because HEAD can't be resolved. For a staged rename,
     * pass both `path` and `oldPath`.
     * @param {string[]} paths @returns {Promise<ActionResult>}
     */
    unstage(paths) {
      if (!paths.length) return Promise.resolve({ ok: true });
      return act("Unstaging…", "short", (timeoutClass) =>
        runOnPaths(snapshot?.unborn ? ["reset", "-q"] : ["restore", "--staged"], paths, timeoutClass));
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
      listeners.clear();
    },
  };
  return self;
}

/** @typedef {ReturnType<typeof createRepository>} Repository */
