// @ts-check
// The Workbench: the UI's single entry point. One per process, at module scope.
// Creating it makes no host calls; nothing runs until `follow`.

import { createGit, GitNotFound } from "./git.js";
import { createRepository, repositoryId } from "./repository.js";
import { createQueue, queueId } from "./queue.js";
import { loadDiff } from "./diff.js";

/** @typedef {import("./platform.js").Platform} Platform */
/** @typedef {import("./queue.js").Queue} Queue */
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
  /** @type {{ repository: Repository, close(): Promise<void> } | null} the followed Repository */
  let current = null;
  let generation = 0;

  /** @param {WorkbenchState} next */
  function setState(next) {
    state = Object.freeze(next);
    for (const fn of [...listeners]) fn();
  }

  /** @type {Map<string, { queue: Queue, users: number }>} queue id → queue shared by Repositories of one common dir */
  const queues = new Map();

  /**
   * Creates a Repository on the queue for its common git dir (shared by Linked worktrees).
   * @param {RepositoryKey} key @param {string} commonDir @param {string} gitDir
   */
  function openRepository(key, commonDir, gitDir) {
    const qid = queueId({ machine: key.machine, commonDir });
    let slot = queues.get(qid);
    if (!slot) queues.set(qid, (slot = { queue: createQueue(), users: 0 }));
    slot.users++;
    const repository = createRepository({ git, key, queue: slot.queue, gitDir, readTextFile: platform.readTextFile });
    const shared = slot;
    return {
      repository,
      /** Disposes the Repository once its queue drains, and drops the queue when nothing else uses it. */
      async close() {
        await shared.queue.drained();
        repository.dispose();
        if (--shared.users === 0 && queues.get(qid) === shared) queues.delete(qid);
      },
    };
  }

  /** Stops following `current`; it is disposed once its queue drains. */
  function leave() {
    if (current) repositories.delete(current.repository.id);
    current?.close();
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
     * Loads a Diff target's DiffDocument. It needs no followed Repository and
     * skips every queue. Rejects with DiffLoadError when git can't diff it.
     * @param {import("./diff-target.js").DiffTarget} target
     */
    loadDiff(target) {
      return loadDiff(git, target);
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
        const top = await git.run(machine, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir"], { cwd: folder, read: true });
        if (stale()) return;
        if (!top.ok) {
          leave();
          return setState({ kind: "no-repository", folder });
        }
        const [toplevel, commonDir, gitDir] = top.stdout.split("\n").map((l) => l.trim());
        const key = { machine: machine ?? null, toplevel };
        if (current?.repository.id === repositoryId(key) && state.kind === "ready") return;

        leave();
        setState({ kind: "loading", folder });
        const opened = openRepository(key, commonDir, gitDir);
        await opened.repository.refresh();
        if (stale()) {
          opened.close();
          return;
        }
        current = opened;
        repositories.set(opened.repository.id, opened.repository);
        setState({ kind: "ready", repository: opened.repository });
      } catch (err) {
        if (stale()) return;
        if (!(err instanceof GitNotFound)) throw err;
        leave();
        setState({ kind: "git-missing" });
      }
    },
  };
}
