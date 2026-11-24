// @ts-check
// Parses `git status --porcelain=v2 -z --branch` (NUL-delimited).

/**
 * @typedef {{ branch: string | null, headOid: string | null, unborn: boolean, detached: boolean }} StatusHeaders
 */

/**
 * @param {string} stdout
 * @returns {StatusHeaders}
 */
export function parseStatus(stdout) {
  /** @type {StatusHeaders} */
  const out = { branch: null, headOid: null, unborn: false, detached: false };
  for (const entry of stdout.split("\0")) {
    if (entry.startsWith("# branch.oid ")) {
      const oid = entry.slice("# branch.oid ".length);
      out.unborn = oid === "(initial)";
      out.headOid = out.unborn ? null : oid;
    } else if (entry.startsWith("# branch.head ")) {
      const head = entry.slice("# branch.head ".length);
      out.detached = head === "(detached)";
      out.branch = out.detached ? null : head;
    }
  }
  return out;
}
