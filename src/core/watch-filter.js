// @ts-check
// Which file-watch events should refresh a Repository, and which folders to watch.
// Git prints `C:/x/y`; watchers report `C:\x\y`, and Herdr's watchFolder on Windows
// reports the verbatim form `\\?\C:\x\y` (`\\?\UNC\server\share\...` for shares).
// Paths are compared normalised (no verbatim prefix, forward slashes, no trailing
// slash, case-folded when they start with a drive letter).

/** @typedef {{ root: string, gitDir: string, commonDir: string }} RepositoryDirs */

/** @param {string} p */
function norm(p) {
  return p.replace(/\\/g, "/")
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\/\/\?\//, "")
    .replace(/\/+$/, "");
}

/** Folds case on Windows drive paths, for comparing folder prefixes. @param {string} p */
const fold = (p) => (/^[a-z]:\//i.test(p) ? p.toLowerCase() : p);

/** `p` relative to `dir` (both normalised; the relative part keeps its case), or null when `p` is not inside `dir`. */
function under(p, dir) {
  const fp = fold(p);
  const fd = fold(dir);
  if (fp === fd) return "";
  return fp.startsWith(fd + "/") ? p.slice(dir.length + 1) : null;
}

/** Files in the per-worktree git dir that change what the panel shows. */
const GIT_DIR_ALLOW = /^(?:index|HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|rebase-[^/]+(?:\/.*)?)$/;
/** Files in the common dir (shared by every worktree) that change what the panel shows. */
const COMMON_DIR_ALLOW = /^(?:refs(?:\/.*)?|packed-refs)$/;

/**
 * Whether a changed path should refresh the Repository. Working-tree changes do;
 * inside the git dirs only the allowlisted files do (lock files, objects, logs and
 * other worktrees' dirs don't).
 * @param {string} changed
 * @param {RepositoryDirs} dirs
 */
export function isRelevant(changed, { root, gitDir, commonDir }) {
  const p = norm(changed);
  const inGit = under(p, norm(gitDir));
  const inCommon = under(p, norm(commonDir));
  if (inGit !== null || inCommon !== null) {
    return (inGit !== null && GIT_DIR_ALLOW.test(inGit)) || (inCommon !== null && COMMON_DIR_ALLOW.test(inCommon));
  }
  return under(p, norm(root)) !== null;
}

/**
 * The folders to watch: the working tree, the git dir and the common dir, minus
 * any already inside another (watches are recursive).
 * @param {RepositoryDirs} dirs
 * @returns {string[]}
 */
export function watchRoots({ root, gitDir, commonDir }) {
  /** @type {string[]} */
  const unique = [];
  for (const d of [root, gitDir, commonDir]) {
    if (!unique.some((u) => under(norm(d), norm(u)) === "")) unique.push(d);
  }
  return unique.filter((d) => !unique.some((o) => o !== d && under(norm(d), norm(o)) !== null));
}
