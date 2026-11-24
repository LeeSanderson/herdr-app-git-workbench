// @ts-check
// A Repository: one followed Git repository, keyed by {machine, toplevel}.
// Created and owned by the Workbench.

import { parseStatus } from "./status.js";
import { createQueue } from "./queue.js";

/** @typedef {ReturnType<import("./git.js").createGit>} Git */
/** @typedef {import("./git.js").TimeoutClass} TimeoutClass */
/** @typedef {{ machine: string | null, toplevel: string }} RepositoryKey */
/** @typedef {{ summary: string, detail: string }} ActionError */
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

/** @param {string} stderr @param {string} fallback @returns {ActionError} */
function errorFrom(stderr, fallback) {
  const detail = stderr.trim();
  const first = detail.split("\n").find((l) => l.trim()) ?? "";
  return { summary: first.trim() || fallback, detail: detail || fallback };
}

/** @typedef {import("./platform.js").Platform["readTextFile"]} ReadTextFile */

/**
 * @param {{ git: Git, key: RepositoryKey, queue?: import("./queue.js").Queue, gitDir?: string, readTextFile?: ReadTextFile }} deps
 *   `queue` is shared by every Repository with the same common git dir. `gitDir` is the
 *   absolute real git dir (per worktree), where `readTextFile` looks for the Operation in
 *   progress; without both, `operation` is always "none".
 */
export function createRepository({ git, key, queue = createQueue(), gitDir, readTextFile }) {
  key = Object.freeze({ machine: key.machine ?? null, toplevel: key.toplevel });
  /** @type {(ReturnType<typeof parseStatus> & { operation: Operation }) | null} */
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

    /** Re-reads the repository from Git. @returns {Promise<ActionResult>} */
    async refresh() {
      const [r, operation] = await Promise.all([
        git.run(key.machine, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"], { cwd: key.toplevel, read: true }),
        gitDir && readTextFile ? readOperation(readTextFile, key.machine, gitDir) : /** @type {Operation} */ ("none"),
      ]);
      if (!r.ok) return { ok: false, error: errorFrom(r.stderr, "git status failed") };
      status = { ...parseStatus(r.stdout), operation };
      publish();
      return { ok: true };
    },

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

    /**
     * Commits what is staged with `message` as one `-m` argument, so Git sees it
     * exactly as typed. Hooks run as on the command line; a failure's `detail` is
     * Git's full output, hook output included. Runs with the long timeout.
     * `amend: true` adds `--amend` (Phase 2; the Phase 1 UI never passes it).
     * @param {{ message: string, amend?: boolean }} options @returns {Promise<ActionResult>}
     */
    commit({ message, amend = false }) {
      return act("Committing…", "long", async (timeoutClass) => {
        const args = ["commit", ...(amend ? ["--amend"] : []), "-m", message];
        const r = await git.run(key.machine, args, { cwd: key.toplevel, timeoutClass });
        // Hooks write to stderr; Git's own refusals ("nothing to commit") go to stdout.
        return r.ok ? null : errorFrom([r.stderr.trim(), r.stdout.trim()].filter(Boolean).join("\n"), "git commit failed");
      });
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
        const fresh = paths.filter((p) => untracked.has(p));
        if (tracked.length) {
          const error = await runOnPaths(["restore", "--worktree"], tracked, timeoutClass);
          if (error) return error;
        }
        // `clean` without -d/-x removes only these untracked files, never ignored ones.
        if (fresh.length) return runOnPaths(["clean", "-f", "-q"], fresh, timeoutClass);
        return null;
      });
    },

    /** True once the Workbench has let go of this Repository and its queue has drained. */
    get disposed() {
      return disposed;
    },

    /** Stops listening and notifying. The Workbench calls it once the queue drains. */
    dispose() {
      disposed = true;
      offQueue();
      listeners.clear();
    },
  };
  return self;
}

/** @typedef {ReturnType<typeof createRepository>} Repository */
