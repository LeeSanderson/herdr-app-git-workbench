// @ts-check
// Parses `git status --porcelain=v2 -z --branch` (NUL-delimited).

/** @typedef {"staged" | "changes" | "untracked" | "conflicts"} ChangeGroup */
/** @typedef {"M" | "A" | "D" | "R" | "T" | "U"} ChangeStatus */
/**
 * One path in one Change group. A path can have both a staged and an unstaged Change.
 * Paths are relative to the Repository's top level, with forward slashes, exactly as Git prints them.
 * @typedef {Readonly<{ path: string, oldPath?: string, status: ChangeStatus, group: ChangeGroup }>} Change
 */
/**
 * @typedef {Readonly<{
 *   staged: readonly Change[],
 *   changes: readonly Change[],
 *   untracked: readonly Change[],
 *   conflicts: readonly Change[],
 * }>} ChangeGroups
 */
/**
 * `upstream` is null when the branch tracks nothing. `ahead`/`behind` are null when
 * there is no upstream or it no longer resolves (for example, deleted on the remote).
 * @typedef {{
 *   branch: string | null, headOid: string | null, unborn: boolean, detached: boolean,
 *   upstream: string | null, ahead: number | null, behind: number | null,
 *   groups: ChangeGroups,
 * }} Status
 */

/**
 * Whether a Change can be discarded: unstaged edits and untracked files only,
 * never staged Changes or Conflicts.
 * @param {Change} change
 */
export const isDiscardable = (change) => change.group === "changes" || change.group === "untracked";

/**
 * The Unstaged list in the order the panel shows it: Conflicts, Changes, Untracked.
 * @param {ChangeGroups} groups
 * @returns {Change[]}
 */
export const unstagedChanges = (groups) => [...groups.conflicts, ...groups.changes, ...groups.untracked];

/**
 * @param {string} stdout
 * @returns {Status}
 */
export function parseStatus(stdout) {
  let branch = null, headOid = null, unborn = false, detached = false;
  /** @type {string | null} */ let upstream = null;
  /** @type {number | null} */ let ahead = null;
  /** @type {number | null} */ let behind = null;
  /** @type {Change[]} */ const staged = [];
  /** @type {Change[]} */ const changes = [];
  /** @type {Change[]} */ const untracked = [];
  /** @type {Change[]} */ const conflicts = [];

  const entries = stdout.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.startsWith("# branch.oid ")) {
      const oid = entry.slice("# branch.oid ".length);
      unborn = oid === "(initial)";
      headOid = unborn ? null : oid;
    } else if (entry.startsWith("# branch.head ")) {
      const head = entry.slice("# branch.head ".length);
      detached = head === "(detached)";
      branch = detached ? null : head;
    } else if (entry.startsWith("# branch.upstream ")) {
      upstream = entry.slice("# branch.upstream ".length);
    } else if (entry.startsWith("# branch.ab ")) {
      const m = /^\+(\d+) -(\d+)$/.exec(entry.slice("# branch.ab ".length));
      if (m) [ahead, behind] = [Number(m[1]), Number(m[2])];
    } else if (entry.startsWith("1 ")) {
      const [xy, path] = fields(entry, 8);
      if (xy[0] !== ".") staged.push(change(path, xy[0], "staged"));
      if (xy[1] !== ".") changes.push(change(path, xy[1], "changes"));
    } else if (entry.startsWith("2 ")) {
      // A rename or copy in the index: the original path is the next NUL-separated entry.
      const [xy, path] = fields(entry, 9);
      const oldPath = entries[++i];
      if (xy[0] !== ".") staged.push(change(path, xy[0], "staged", oldPath));
      if (xy[1] !== ".") changes.push(change(path, xy[1], "changes"));
    } else if (entry.startsWith("u ")) {
      const [, path] = fields(entry, 10);
      conflicts.push(change(path, "U", "conflicts"));
    } else if (entry.startsWith("? ")) {
      untracked.push(change(entry.slice(2), "A", "untracked"));
    }
  }
  return { branch, headOid, unborn, detached, upstream, ahead, behind, groups: Object.freeze({ staged, changes, untracked, conflicts }) };
}

/**
 * Splits an entry into its XY field and its path: `<kind> <XY> ... <path>`, where
 * the path is everything after `count` space-separated fields (it may contain spaces).
 * @param {string} entry @param {number} count
 */
function fields(entry, count) {
  let at = 0;
  for (let n = 0; n < count; n++) at = entry.indexOf(" ", at) + 1;
  return [entry.slice(2, 4), entry.slice(at)];
}

/**
 * @param {string} path @param {string} letter @param {ChangeGroup} group @param {string} [oldPath]
 * @returns {Change}
 */
function change(path, letter, group, oldPath) {
  /** @type {ChangeStatus} */
  const status = letter === "C" ? "A" : /** @type {ChangeStatus} */ (letter);
  return Object.freeze(oldPath === undefined ? { path, status, group } : { path, oldPath, status, group });
}
