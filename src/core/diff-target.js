// @ts-check
// Diff targets: what a Diff view compares. A target is plain JSON because it
// travels through `tab.new` props; it carries enough to reload without the panel.

/** @typedef {import("./repository.js").RepositoryKey} RepositoryKey */
/** @typedef {import("./status.js").Change} Change */
/** @typedef {"HEAD" | "INDEX" | "WORKTREE" | "EMPTY" | string} Side  a commit sha is also a side */
/**
 * @typedef {{
 *   repository: RepositoryKey,
 *   left: Side,
 *   right: Side,
 *   oldPath: string,
 *   newPath: string,
 *   group: Change["group"],
 *   status: Change["status"],
 * }} DiffTarget
 * `group` and `status` are extras for the Diff view's header (badge and letter).
 */

/** @type {Record<string, [Side, Side]>} */
const SIDES = {
  staged: ["HEAD", "INDEX"],
  changes: ["INDEX", "WORKTREE"],
  untracked: ["EMPTY", "WORKTREE"],
  conflicts: ["INDEX", "WORKTREE"],
};

/**
 * The Diff target that shows `change` from the Repository with key `repositoryKey`. Pure.
 * @param {RepositoryKey} repositoryKey @param {Change} change
 * @returns {DiffTarget}
 */
export function diffTargetFor(repositoryKey, change) {
  const [left, right] = SIDES[change.group];
  return {
    repository: { machine: repositoryKey.machine ?? null, toplevel: repositoryKey.toplevel },
    left,
    right,
    oldPath: change.oldPath ?? change.path,
    newPath: change.path,
    group: change.group,
    status: change.status,
  };
}

/**
 * A stable string for a Diff target, for the tab registry. Staged and unstaged
 * diffs of one file differ by sides, so they get different keys.
 * @param {DiffTarget} t
 */
export function targetKey(t) {
  return JSON.stringify([t.repository.machine ?? null, t.repository.toplevel, t.left, t.right, t.oldPath, t.newPath]);
}

/**
 * The Herdr tab name for a Diff view: `Δ <file>` or `Δ <file> (staged)`.
 * @param {DiffTarget} t
 */
export function tabName(t) {
  const name = t.newPath.slice(t.newPath.lastIndexOf("/") + 1);
  return `Δ ${name}${t.right === "INDEX" ? " (staged)" : ""}`;
}
