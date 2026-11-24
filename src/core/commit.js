// @ts-check
// Whether a commit can go ahead, and the commit box's status line.

/**
 * Commit is blocked while Conflicts remain, when nothing is staged, or when the
 * message is empty (whitespace only counts as empty). Checked in that order.
 * @param {import("./status.js").ChangeGroups} groups
 * @param {string} message
 * @returns {{ ready: boolean, status: string }}
 */
export function commitReadiness(groups, message) {
  if (groups.conflicts.length) return { ready: false, status: `Resolve ${groups.conflicts.length} conflict(s) first` };
  if (!groups.staged.length) return { ready: false, status: "Nothing staged" };
  const files = `${groups.staged.length} file(s) ready`;
  if (!message.trim()) return { ready: false, status: `${files}. Write a commit message` };
  return { ready: true, status: files };
}
