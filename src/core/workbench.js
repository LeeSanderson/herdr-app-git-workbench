// @ts-check
// The Workbench: the UI's single entry point. One per process, at module scope.
// Creating it makes no host calls; nothing runs until `follow`.

import { createGit, GitNotFound } from "./git.js";
import { createRepository } from "./repository.js";
import { repositoryKey, repositoryId } from "./repository-key.js";
import { createSignal } from "./signal.js";
import { createQueue, queueId } from "./queue.js";
import { loadDiff } from "./diff.js";

/** @typedef {import("./platform.js").Platform} Platform */
/** @typedef {import("./queue.js").Queue} Queue */
/** @typedef {import("./repository.js").Repository} Repository */
/** @typedef {import("./repository-key.js").RepositoryKey} RepositoryKey */
/** @typedef {import("./follow-place.js").Place} Place */
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
  const changes = createSignal();
  /** @type {Map<string, Repository>} Repository id → Repository */
  const repositories = new Map();
  /** @type {{ repository: Repository, close(): Promise<void> } | null} the followed Repository */
  let current = null;
  let generation = 0;
  /** Where the latest `follow` call asked to go. @type {Place | null} */
  let requested = null;

  /** @param {WorkbenchState} next */
  function setState(next) {
    state = Object.freeze(next);
    changes.emit();
  }

  /** @type {Map<string, { queue: Queue, users: number }>} queue id → queue shared by Repositories of one common dir */
  const queues = new Map();

  /**
   * Creates a Repository on the queue for its common git dir (shared by Linked worktrees).
   * It watches its working tree and git dirs until it is closed.
   * @param {RepositoryKey} key @param {string} commonDir @param {string} gitDir
   */
  function openRepository(key, commonDir, gitDir) {
    const qid = queueId({ machine: key.machine, commonDir });
    let slot = queues.get(qid);
    if (!slot) queues.set(qid, (slot = { queue: createQueue(), users: 0 }));
    slot.users++;
    const repository = createRepository({
      git, key, queue: slot.queue, platform, dirs: { root: key.toplevel, gitDir, commonDir },
    });
    const shared = slot;
    return {
      repository,
      /** Disposes the Repository (stopping its watch) once its queue drains, and drops the queue when nothing else uses it. */
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
    subscribe: changes.subscribe,

    /**
     * The followed Repository with this key, or undefined when it is no longer followed.
     * @param {RepositoryKey | string} key
     */
    repository(key) {
      return repositories.get(repositoryId(key));
    },

    /**
     * Loads a Diff target's DiffDocument. It needs no followed Repository and
     * skips every queue. Resolves `{ ok: false, error }` when git can't diff it.
     * @param {import("./diff-target.js").DiffTarget} target
     */
    loadDiff(target) {
      return loadDiff(git, target);
    },

    /**
     * Whether the latest `follow` call (still resolving or done) was for `where`.
     * Panel copies use it to follow the active space only when it differs.
     * @param {Place} where
     */
    isFollowing({ machine, folder }) {
      return requested !== null && requested.machine === (machine ?? null) && requested.folder === folder;
    },

    /**
     * Follows the Repository containing `folder` on `machine` (null = local).
     * A later call supersedes an earlier one still resolving.
     * @param {Place} where
     */
    async follow({ machine, folder }) {
      requested = { machine: machine ?? null, folder };
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
        const key = repositoryKey({ machine, toplevel });
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
