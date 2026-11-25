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

/**
 * What a relevant path changes: `worktree` (status only: working-tree files, the
 * index, Operation markers) or `refs` (HEAD or a Ref moved: status and the Graph).
 * @typedef {"worktree" | "refs"} WatchLabel
 */

/** Files in the per-worktree git dir that move HEAD or its per-worktree Refs. */
const GIT_DIR_REFS = /^(?:HEAD|reftable(?:\/.*)?)$/;
/** Other files in the per-worktree git dir that change what the panel shows. */
const GIT_DIR_WORKTREE = /^(?:index|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|rebase-[^/]+(?:\/.*)?)$/;
/** Files in the common dir (shared by every worktree) that hold the Refs: loose, packed or reftable. */
const COMMON_DIR_REFS = /^(?:refs(?:\/.*)?|packed-refs|reftable(?:\/.*)?)$/;

/**
 * Whether a changed path should refresh the Repository, and how: `refs` paths
 * also reload the Graph. Working-tree changes are `worktree`; inside the git dirs
 * only the allowlisted files count. Git writes `<name>.lock` and renames it into
 * place; a watcher may report only the lock name, so a lock file under the Refs
 * paths (HEAD, loose refs, packed-refs, reftable) is `refs` too (the debounce
 * absorbs the extra event), and any other lock file is null. Objects, logs and
 * other worktrees' dirs are null.
 * @param {string} changed
 * @param {RepositoryDirs} dirs
 * @returns {WatchLabel | null}
 */
export function watchLabel(changed, { root, gitDir, commonDir }) {
  const p = norm(changed);
  let inGit = under(p, norm(gitDir));
  let inCommon = under(p, norm(commonDir));
  if (inGit !== null || inCommon !== null) {
    const lock = p.endsWith(".lock");
    if (lock) {
      inGit = inGit?.slice(0, -".lock".length) ?? null;
      inCommon = inCommon?.slice(0, -".lock".length) ?? null;
    }
    if (inGit !== null && GIT_DIR_REFS.test(inGit)) return "refs";
    if (inCommon !== null && COMMON_DIR_REFS.test(inCommon)) return "refs";
    if (lock) return null;
    if (inGit !== null && GIT_DIR_WORKTREE.test(inGit)) return "worktree";
    return null;
  }
  return under(p, norm(root)) !== null ? "worktree" : null;
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
