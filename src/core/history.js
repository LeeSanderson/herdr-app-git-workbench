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
 *   badges: readonly RefBadge[],
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
    const [oid, parents, authorName, authorEmail, authorDate, decorations, subject, message] = fields.slice(i, i + FIELDS);
    const refs = decorations.split(", ").map((r) => r.trim()).filter(Boolean);
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
      refs: Object.freeze(refs),
      badges: Object.freeze(refBadges(refs)),
    }));
  }
  return commits;
}

/**
 * One Ref on a commit. `head` is HEAD: named after its branch when attached, "HEAD"
 * when detached (the attached branch gets no separate local badge).
 * @typedef {Readonly<{ kind: "head" | "local" | "remote" | "tag", name: string }>} RefBadge
 */

const BADGE_ORDER = ["head", "local", "remote", "tag"];

/**
 * The badges for a commit's full decorations, HEAD first, then local branches,
 * remote branches and tags (each in git's order). A remote's symbolic HEAD
 * (`origin/HEAD`), stash and any other refs (notes, `refs/pull/*`) get none.
 * @param {readonly string[]} refs @returns {RefBadge[]}
 */
export function refBadges(refs) {
  /** @type {RefBadge[]} */
  const out = [];
  for (const ref of refs) {
    /** @type {RefBadge | null} */
    let badge = null;
    let m;
    if (ref === "HEAD") badge = { kind: "head", name: "HEAD" };
    else if ((m = /^HEAD -> refs\/heads\/(.+)$/.exec(ref))) badge = { kind: "head", name: m[1] };
    else if ((m = /^tag: refs\/tags\/(.+)$/.exec(ref))) badge = { kind: "tag", name: m[1] };
    else if ((m = /^refs\/heads\/(.+)$/.exec(ref))) badge = { kind: "local", name: m[1] };
    else if ((m = /^refs\/remotes\/(.+)$/.exec(ref)) && !/^[^/]+\/HEAD$/.test(m[1])) badge = { kind: "remote", name: m[1] };
    if (badge) out.push(Object.freeze(badge));
  }
  return out.sort((a, b) => BADGE_ORDER.indexOf(a.kind) - BADGE_ORDER.indexOf(b.kind));
}

/** Whether a decoration list says this commit is HEAD. @param {readonly string[]} refs */
export function isHeadCommit(refs) {
  return refs.some((r) => r === "HEAD" || r.startsWith("HEAD -> "));
}
