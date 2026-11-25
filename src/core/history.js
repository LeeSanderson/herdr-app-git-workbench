// @ts-check
// The Graph's history query: one topological-order, NUL-delimited `git log`,
// and the parser that turns its output into the commit model.

/** Commits the Graph shows at first, and adds per Load more. */
export const PAGE_SIZE = 50;

/**
 * One commit of the Graph. `refs` are the raw full decorations (for example
 * "HEAD -> refs/heads/main", "tag: refs/tags/v1", "refs/remotes/origin/main").
 * @typedef {Readonly<{
 *   oid: string,
 *   parents: readonly string[],
 *   authorName: string,
 *   authorEmail: string,
 *   authorDate: string,
 *   subject: string,
 *   message: string,
 *   refs: readonly string[],
 * }>} Commit
 */

// Field order of one record. The message comes last; no field can hold a NUL.
const FORMAT = ["%H", "%P", "%an", "%ae", "%aI", "%D", "%s", "%B"];
const FIELDS = FORMAT.length;

/**
 * The `git log` arguments for up to `count` commits reachable from `revisions`.
 * Stash refs are left out of the decorations.
 * @param {readonly string[]} revisions @param {number} count
 */
export function historyArgs(revisions, count) {
  return [
    "log", "-z", "--topo-order", `--max-count=${count}`,
    "--decorate=full", "--decorate-refs-exclude=refs/stash",
    `--format=${FORMAT.join("%x00")}`,
    ...revisions, "--",
  ];
}

/**
 * Parses `git log` output made with `historyArgs`. Records and fields are both
 * NUL-separated, so the output is read by field count.
 * @param {string} stdout @returns {Commit[]}
 */
export function parseHistory(stdout) {
  const fields = stdout.split("\0");
  /** @type {Commit[]} */
  const commits = [];
  for (let i = 0; i + FIELDS <= fields.length; i += FIELDS) {
    const [oid, parents, authorName, authorEmail, authorDate, refs, subject, message] = fields.slice(i, i + FIELDS);
    commits.push(Object.freeze({
      // Every record after the first starts right after the previous message's NUL;
      // git may add a newline between records.
      oid: oid.trim(),
      parents: Object.freeze(parents.split(" ").filter(Boolean)),
      authorName,
      authorEmail,
      authorDate,
      subject,
      message,
      refs: Object.freeze(refs.split(", ").map((r) => r.trim()).filter(Boolean)),
    }));
  }
  return commits;
}

/** Whether a decoration list says this commit is HEAD. @param {readonly string[]} refs */
export function isHeadCommit(refs) {
  return refs.some((r) => r === "HEAD" || r.startsWith("HEAD -> "));
}
