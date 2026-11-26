// @ts-check
// A commit's changed files: a NUL-delimited, rename-detecting name-status tree
// diff of the commit against its first parent (a root commit or shallow
// boundary is diffed as a root).

/**
 * One changed file of a commit. Type changes show as M. `oldPath` is set for renames only.
 * @typedef {Readonly<{ status: "M" | "A" | "D" | "R", path: string, oldPath?: string }>} CommitFile
 */

/**
 * The tree-diff arguments for a commit with the given parents.
 * @param {{ oid: string, parents: readonly string[] }} commit
 */
export function commitFilesArgs(commit) {
  const flags = ["diff-tree", "-r", "-z", "-M", "--name-status", "--no-commit-id"];
  const first = commit.parents[0];
  return first ? [...flags, first, commit.oid, "--"] : [...flags, "--root", commit.oid, "--"];
}

/**
 * Parses `diff-tree -z --name-status` output: "<status>\0<path>\0", or
 * "R<score>\0<old>\0<new>\0" for a rename.
 * @param {string} stdout @returns {CommitFile[]}
 */
export function parseCommitFiles(stdout) {
  const fields = stdout.split("\0");
  /** @type {CommitFile[]} */
  const files = [];
  for (let i = 0; i < fields.length; ) {
    const code = fields[i++].trim();
    if (!code) continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = fields[i++];
      const path = fields[i++];
      files.push(Object.freeze(letter === "R" ? { status: "R", path, oldPath } : { status: "A", path }));
    } else {
      const path = fields[i++];
      const status = letter === "A" || letter === "D" ? letter : "M";
      files.push(Object.freeze({ status, path }));
    }
  }
  return files;
}
