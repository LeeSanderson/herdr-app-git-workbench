// @ts-check
// A Repository: one followed Git repository, keyed by {machine, toplevel}.
// Created and owned by the Workbench.

import { parseStatus } from "./status.js";

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
 * @param {{ git: Git, key: RepositoryKey }} deps
 */
export function createRepository({ git, key }) {
  key = Object.freeze({ machine: key.machine ?? null, toplevel: key.toplevel });
  /** @type {Snapshot | null} */
  let snapshot = null;
  /** @type {Set<() => void>} */
  const listeners = new Set();

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

    /** Re-reads the repository from Git. @returns {Promise<{ ok: boolean, error?: { summary: string, detail: string } }>} */
    async refresh() {
      const r = await git.run(key.machine, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"], { cwd: key.toplevel, read: true });
      if (!r.ok) {
        const detail = r.stderr.trim();
        return { ok: false, error: { summary: detail.split("\n")[0] || "git status failed", detail } };
      }
      snapshot = Object.freeze(parseStatus(r.stdout));
      for (const fn of [...listeners]) fn();
      return { ok: true };
    },
  };
}

/** @typedef {ReturnType<typeof createRepository>} Repository */
