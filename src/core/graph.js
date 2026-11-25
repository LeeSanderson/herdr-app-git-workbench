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
import { repositoryId } from "./repository-key.js";

/** @typedef {import("./history.js").Commit} Commit */
/** @typedef {import("./lanes.js").LaneRow} LaneRow */
/** @typedef {import("./errors.js").ActionError} ActionError */
/**
 * Which Refs the Graph starts from: HEAD and its Upstream, every branch, remote
 * branch and tag, or HEAD only.
 * @typedef {"auto" | "all" | "current"} RefFilter
 */

/** @type {readonly RefFilter[]} */
export const REF_FILTERS = Object.freeze(["auto", "all", "current"]);

/** The per-Repository setting key of the Ref filter. @param {import("./repository-key.js").RepositoryKey} key */
export const refFilterSetting = (key) => `gitwb.refFilter.${repositoryId(key)}`;

/**
 * @typedef {{ unborn: boolean, detached: boolean, upstream: string | null, ahead: number | null }} HeadStatus
 */

/**
 * The revisions a Ref filter starts from. Auto adds the Upstream only when it is
 * set and still resolves (ahead/behind known) and HEAD is attached. All names
 * branches, remote branches and tags, never every ref (stash, notes, pull
 * requests). An unborn HEAD has no history: no revisions.
 * @param {RefFilter} filter @param {HeadStatus | null} status @returns {string[]}
 */
function filterRevisions(filter, status) {
  if (status?.unborn) return [];
  if (filter === "all") return ["HEAD", "--branches", "--remotes", "--tags"];
  const upstream = filter === "auto" && status && status.upstream !== null && status.ahead !== null && !status.detached;
  return upstream ? ["HEAD", "@{upstream}"] : ["HEAD"];
}
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
 *   status: () => HeadStatus | null,
 *   settings: Pick<import("./platform.js").Platform, "getSetting" | "setSetting">,
 * }} deps `status` gives the Repository's latest status (null before the first read);
 *   `settings` remembers the Ref filter per Repository.
 */
export function createGraph({ git, key, status, settings }) {
  /** @type {GraphState} */
  let state = Object.freeze({ kind: "idle" });
  const saved = settings.getSetting(refFilterSetting(key));
  /** @type {RefFilter} */
  let filter = REF_FILTERS.find((f) => f === saved) ?? "auto";
  let disposed = false;
  const changes = createSignal();

  /** @param {GraphState} next */
  function set(next) {
    if (disposed) return;
    state = Object.freeze(next);
    changes.emit();
  }

  async function read() {
    const revs = filterRevisions(filter, status());
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

  const load = coalesce(read);

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
    load,

    /** The Ref filter, remembered per Repository (Auto until chosen). @returns {RefFilter} */
    get filter() {
      return filter;
    },

    /**
     * Chooses the Ref filter, remembers it for this Repository and reloads.
     * @param {RefFilter} next @returns {Promise<void>}
     */
    setFilter(next) {
      if (!REF_FILTERS.includes(next)) throw new Error(`Unknown Ref filter: ${next}`);
      filter = next;
      settings.setSetting(refFilterSetting(key), next);
      changes.emit();
      return load();
    },

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
