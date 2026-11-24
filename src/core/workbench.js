// @ts-check
// The Workbench: the UI's single entry point. One per process, at module scope.
// Creating it makes no host calls; nothing runs until `follow`.

import { createGit, GitNotFound } from "./git.js";
import { createRepository, repositoryId } from "./repository.js";

/** @typedef {import("./platform.js").Platform} Platform */
/** @typedef {import("./repository.js").Repository} Repository */
/** @typedef {import("./repository.js").RepositoryKey} RepositoryKey */
/**
 * Immutable tagged union, discriminated by `kind`.
 * @typedef {Readonly<{ kind: "git-missing" }
 *   | { kind: "no-repository", folder: string }
 *   | { kind: "loading", folder: string }
 *   | { kind: "ready", repository: Repository }>} WorkbenchState
 */

/** @param {Platform} platform */
export function createWorkbench(platform) {
  const git = createGit(platform);
  /** @type {WorkbenchState} */
  let state = Object.freeze({ kind: "loading", folder: "" });
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {Map<string, Repository>} Repository id → Repository */
  const repositories = new Map();
  /** @type {Repository | null} */
  let current = null;
  let generation = 0;

  /** @param {WorkbenchState} next */
  function setState(next) {
    state = Object.freeze(next);
    for (const fn of [...listeners]) fn();
  }

  /** Stops following `current`: its watch stops and it is disposed. */
  function leave() {
    if (current) {
      repositories.delete(current.id);
      current.dispose();
    }
    current = null;
  }

  return {
    /** @returns {WorkbenchState} */
    get state() {
      return state;
    },

    /** Called after every state change. @param {() => void} fn @returns {() => void} */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * The followed Repository with this key, or undefined when it is no longer followed.
     * @param {RepositoryKey | string} key
     */
    repository(key) {
      return repositories.get(repositoryId(key));
    },

    /**
     * Follows the Repository containing `folder` on `machine` (null = local).
     * A later call supersedes an earlier one still resolving.
     * @param {{ machine: string | null, folder: string }} where
     */
    async follow({ machine, folder }) {
      const mine = ++generation;
      const stale = () => mine !== generation;
      try {
        const top = await git.run(machine, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"], { cwd: folder, read: true });
        if (stale()) return;
        if (!top.ok) {
          leave();
          return setState({ kind: "no-repository", folder });
        }
        const [toplevel, gitDir, commonDir] = top.stdout.split(/\r?\n/);
        const key = { machine: machine ?? null, toplevel };
        if (current?.id === repositoryId(key) && state.kind === "ready") return;

        leave();
        setState({ kind: "loading", folder });
        const repository = createRepository({ git, key, platform, dirs: { root: toplevel, gitDir, commonDir } });
        await repository.refresh();
        if (stale()) return repository.dispose();
        current = repository;
        repositories.set(repository.id, repository);
        setState({ kind: "ready", repository });
      } catch (err) {
        if (stale()) return;
        if (!(err instanceof GitNotFound)) throw err;
        leave();
        setState({ kind: "git-missing" });
      }
    },
  };
}
