// @ts-check
// The Graph of one Repository: its history snapshot and lane layout.
//
// A load is a read: `git log` with the read-only flags takes no locks, so it
// runs beside the Repository's queue, not on it, like status. That keeps the
// queue (and so `snapshot.running`, which disables the Change groups) free of
// Graph loads: staging and committing never wait for history, and a slow or
// failed load never blocks them. Every load replaces the whole model.

import { historyArgs, parseHistory, isHeadCommit, PAGE_SIZE } from "./history.js";
import { layoutLanes } from "./lanes.js";
import { createSignal, coalesce } from "./signal.js";
import { actionError, messageOf } from "./errors.js";

/** @typedef {import("./history.js").Commit} Commit */
/** @typedef {import("./lanes.js").LaneRow} LaneRow */
/** @typedef {import("./errors.js").ActionError} ActionError */
/**
 * Immutable tagged union, discriminated by `kind`.
 * - idle: never loaded. loading: the first load runs (a reload keeps the
 *   previous state until it lands).
 * - empty: there are no commits (an unborn HEAD); no git ran.
 * - ready: `commits` and their lane `rows` (same order), the HEAD commit's oid,
 *   and whether history goes on past what is shown.
 * - error: the load failed; `load()` again retries.
 * @typedef {Readonly<{ kind: "idle" }
 *   | { kind: "loading" }
 *   | { kind: "empty" }
 *   | { kind: "ready", commits: readonly Commit[], rows: readonly LaneRow[], head: string | null, count: number, hasMore: boolean }
 *   | { kind: "error", error: ActionError }>} GraphState
 */

/**
 * @param {{
 *   git: ReturnType<import("./git.js").createGit>,
 *   key: import("./repository-key.js").RepositoryKey,
 *   status: () => { unborn: boolean } | null,
 * }} deps `status` gives the Repository's latest status (null before the first read).
 */
export function createGraph({ git, key, status }) {
  /** @type {GraphState} */
  let state = Object.freeze({ kind: "idle" });
  let disposed = false;
  const changes = createSignal();

  /** @param {GraphState} next */
  function set(next) {
    if (disposed) return;
    state = Object.freeze(next);
    changes.emit();
  }

  /** The revisions to start from: HEAD, unless it is unborn. */
  function revisions() {
    return status()?.unborn ? [] : ["HEAD"];
  }

  async function read() {
    const revs = revisions();
    if (!revs.length) return set({ kind: "empty" });
    if (state.kind === "idle" || state.kind === "empty") set({ kind: "loading" });
    const count = PAGE_SIZE;
    try {
      // One more than shown says whether history goes on.
      const r = await git.run(key.machine, historyArgs(revs, count + 1), { cwd: key.toplevel, read: true });
      if (!r.ok) return set({ kind: "error", error: actionError(r.stderr, "git log failed") });
      const all = parseHistory(r.stdout);
      const commits = all.slice(0, count);
      if (!commits.length) return set({ kind: "empty" });
      set({
        kind: "ready",
        commits,
        rows: layoutLanes(commits),
        head: commits.find((c) => isHeadCommit(c.refs))?.oid ?? null,
        count,
        hasMore: all.length > count,
      });
    } catch (err) {
      // GitNotFound / GitTimeout
      set({ kind: "error", error: { summary: messageOf(err), detail: messageOf(err) } });
    }
  }

  return {
    /** @returns {GraphState} */
    get state() {
      return state;
    },

    /** Called after every Graph state change. @param {() => void} fn @returns {() => void} */
    subscribe: changes.subscribe,

    /**
     * Loads (or reloads, or retries) the history. A call while one runs merges
     * into a single follow-up. Failures land in the state as an error; it never rejects.
     * @returns {Promise<void>}
     */
    load: coalesce(read),

    /** True once loaded at least once (whatever the outcome), so reloads are worth running. */
    get started() {
      return state.kind !== "idle";
    },

    dispose() {
      disposed = true;
      changes.clear();
    },
  };
}

/** @typedef {ReturnType<typeof createGraph>} Graph */
