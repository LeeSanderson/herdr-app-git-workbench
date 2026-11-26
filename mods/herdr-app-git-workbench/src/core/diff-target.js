// @ts-check
// Diff targets: what a Diff view compares. A target is plain JSON because it
// travels through `tab.new` props; it carries enough to reload without the panel.

import { repositoryKey, machineId } from "./repository-key.js";
import { nameOf } from "./status.js";

/** @typedef {import("./repository-key.js").RepositoryKey} RepositoryKey */
/** @typedef {import("./status.js").Change} Change */
/** @typedef {"HEAD" | "INDEX" | "WORKTREE" | "EMPTY" | string} Side  a commit sha is also a side */
/**
 * @typedef {{
 *   repository: RepositoryKey,
 *   left: Side,
 *   right: Side,
 *   oldPath: string,
 *   newPath: string,
 *   group: Change["group"] | "commit",
 *   status: Change["status"],
 * }} DiffTarget
 * `group` and `status` are extras for the Diff view's header (badge and letter).
 * A commit file's group is "commit"; its right side is the commit's full oid.
 */

/** @type {Record<string, [Side, Side]>} */
const SIDES = {
  staged: ["HEAD", "INDEX"],
  changes: ["INDEX", "WORKTREE"],
  untracked: ["EMPTY", "WORKTREE"],
  conflicts: ["INDEX", "WORKTREE"],
};

/**
 * The Diff target that shows `change` from the Repository with key `key`. Pure.
 * @param {RepositoryKey} key @param {Change} change
 * @returns {DiffTarget}
 */
export function diffTargetFor(key, change) {
  const [left, right] = SIDES[change.group];
  return {
    repository: { ...repositoryKey(key) },
    left,
    right,
    oldPath: change.oldPath ?? change.path,
    newPath: change.path,
    group: change.group,
    status: change.status,
  };
}

/**
 * The Diff target that shows one changed file of a commit: from its first
 * parent's full oid (EMPTY for a root commit or shallow boundary) to the
 * commit's full oid. A merge is compared with its first parent. Pure.
 * @param {RepositoryKey} key
 * @param {{ oid: string, parents: readonly string[] }} commit
 * @param {import("./commit-files.js").CommitFile} file
 * @returns {DiffTarget}
 */
export function commitFileTarget(key, commit, file) {
  return {
    repository: { ...repositoryKey(key) },
    left: commit.parents[0] ?? "EMPTY",
    right: commit.oid,
    oldPath: file.oldPath ?? file.path,
    newPath: file.path,
    group: "commit",
    status: file.status,
  };
}

/**
 * A stable string for a Diff target, for the tab registry. Staged and unstaged
 * diffs of one file differ by sides, so they get different keys.
 * @param {DiffTarget} t
 */
export function targetKey(t) {
  return machineId(t.repository.machine, t.repository.toplevel, t.left, t.right, t.oldPath, t.newPath);
}

/**
 * The Herdr tab name for a Diff view: `Δ <file>` or `Δ <file> (staged)`.
 * @param {DiffTarget} t
 */
export function tabName(t) {
  if (t.group === "commit") return `Δ ${nameOf(t.newPath)} (${t.right.slice(0, 7)})`;
  return `Δ ${nameOf(t.newPath)}${t.right === "INDEX" ? " (staged)" : ""}`;
}
