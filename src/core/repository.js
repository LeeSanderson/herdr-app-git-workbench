// @ts-check
// A Repository: one followed Git repository, keyed by {machine, toplevel}.
// Created and owned by the Workbench.

import { parseStatus } from "./status.js";
import { isRelevant, watchRoots } from "./watch-filter.js";

/** Quiet time after the last relevant file event before refreshing. */
export const DEBOUNCE_MS = 400;

/** @typedef {ReturnType<import("./git.js").createGit>} Git */
/** @typedef {{ machine: string | null, toplevel: string }} RepositoryKey */
/**
 * @typedef {Readonly<{
 *   branch: string | null,
 *   headOid: string | null,
 *   unborn: boolean,
 *   detached: boolean,
 *   groups: import("./status.js").ChangeGroups,
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
 * With `platform` and `dirs`, the Repository watches its working tree and git
 * dirs until `dispose()`, refreshing (debounced) on relevant events.
 * @param {{ git: Git, key: RepositoryKey, platform?: import("./platform.js").Platform, dirs?: import("./watch-filter.js").RepositoryDirs }} deps
 */
export function createRepository({ git, key, platform, dirs }) {
  key = Object.freeze({ machine: key.machine ?? null, toplevel: key.toplevel });
  /** @type {Snapshot | null} */
  let snapshot = null;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  let disposed = false;

  /** Re-reads the repository from Git. @returns {Promise<{ ok: boolean, error?: { summary: string, detail: string } }>} */
  async function readStatus() {
    const r = await git.run(key.machine, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"], { cwd: key.toplevel, read: true });
    if (!r.ok) {
      const detail = r.stderr.trim();
      return { ok: false, error: { summary: detail.split("\n")[0] || "git status failed", detail } };
    }
    if (disposed) return { ok: true };
    snapshot = Object.freeze(parseStatus(r.stdout));
    for (const fn of [...listeners]) fn();
    return { ok: true };
  }

  // A refresh requested while one runs merges into a single follow-up.
  /** @type {ReturnType<typeof readStatus> | null} */
  let running = null;
  /** @type {ReturnType<typeof readStatus> | null} */
  let followUp = null;
  /** @returns {ReturnType<typeof readStatus>} */
  function refresh() {
    if (!running) {
      running = readStatus().finally(() => {
        running = null;
      });
      return running;
    }
    if (!followUp) {
      followUp = running.then(
        () => {
          followUp = null;
          return refresh();
        },
        () => {
          followUp = null;
          return refresh();
        },
      );
    }
    return followUp;
  }

  // Debounce: refresh once events have been quiet for DEBOUNCE_MS.
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

  return {
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

    /** Re-reads the repository from Git; merges with one already running. */
    refresh,

    /** Stops watching. Pending debounced refreshes are dropped. */
    dispose() {
      disposed = true;
      for (const w of watches.splice(0)) w.cancel();
    },
  };
}

/** @typedef {ReturnType<typeof createRepository>} Repository */
