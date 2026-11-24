// @ts-check
// Loading a Diff target into a DiffDocument: runs `git diff` for the whole file
// and parses the patch into a line model. Rows for display come from rows.js.

import { buildRows } from "./rows.js";

/** @typedef {ReturnType<import("./git.js").createGit>} Git */
/** @typedef {import("./diff-target.js").DiffTarget} DiffTarget */
/**
 * One line of the patch body. `a`/`b` are old/new line numbers; `text` is raw
 * (no prefix, no newline; a CR of a CRLF line is kept for the UI to show).
 * @typedef {{ kind: "ctx" | "del" | "add", a?: number, b?: number, text: string, noeol?: true }} PatchLine
 */

/** Whole file: more context than any file has lines. */
const WHOLE_FILE = "-U99999999";
const DIFF_FLAGS = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", WHOLE_FILE];

export class DiffLoadError extends Error {
  /** @param {string} message @param {string} detail */
  constructor(message, detail) {
    super(message);
    this.name = "DiffLoadError";
    this.detail = detail;
  }
}

/**
 * The `git diff` arguments for a target's sides. Paths always follow "--".
 * @param {DiffTarget} t
 */
function diffArgs(t) {
  if (t.left === "EMPTY") return [...DIFF_FLAGS, "--no-index", "--", "/dev/null", t.newPath];
  if (t.left === "HEAD" && t.right === "INDEX") {
    const paths = t.oldPath !== t.newPath ? [t.oldPath, t.newPath] : [t.newPath];
    return [...DIFF_FLAGS, "--cached", "-M", "--", ...paths];
  }
  if (t.left === "INDEX" && t.right === "WORKTREE") return [...DIFF_FLAGS, "--", t.newPath];
  throw new Error(`Unsupported Diff target sides ${t.left}→${t.right}`);
}

/**
 * Loads a Diff target. Reads run straight through the Git runner, not the
 * Repository's queue, so a diff never waits behind a stage or commit.
 * @param {Git} git @param {DiffTarget} target
 */
export async function loadDiff(git, target) {
  const { machine, toplevel } = target.repository;
  const r = await git.run(machine, diffArgs(target), { cwd: toplevel, read: true });
  // `--no-index` exits 1 when the files differ; anything above that is an error.
  const failed = target.left === "EMPTY" ? r.code > 1 || r.code < 0 : !r.ok;
  if (failed) {
    const detail = r.stderr.trim();
    throw new DiffLoadError(detail.split("\n")[0] || "git diff failed", detail);
  }
  return createDiffDocument(target, parsePatch(r.stdout));
}

/**
 * Parses a single-file unified patch into its file header lines, its hunks
 * (raw hunk header plus raw lines, exactly as git printed them, for toPatch())
 * and its body lines.
 * @param {string} text
 */
export function parsePatch(text) {
  const raw = text.endsWith("\n") ? text.slice(0, -1) : text;
  const all = raw === "" ? [] : raw.split("\n");
  /** @type {string[]} */
  const header = [];
  /** @type {{ header: string, lines: string[] }[]} */
  const hunks = [];
  /** @type {PatchLine[]} */
  const body = [];
  let i = 0;
  for (; i < all.length && !all[i].startsWith("@@"); i++) header.push(all[i]);
  // A combined diff (a Conflict) has one prefix column per parent and `@@@`
  // hunk headers. Its body is read as a diff from the first parent (HEAD's
  // side, "ours") to the result: column 1 decides, and lines that only another
  // parent had are left out of the body (they stay in the raw hunk).
  let parents = 1;
  let a = 0;
  let b = 0;
  for (; i < all.length; i++) {
    const l = all[i];
    const m = /^(@@+) -(\d+)(?:,\d+)?(?: -\d+(?:,\d+)?)* \+(\d+)(?:,\d+)? \1/.exec(l);
    if (m) {
      parents = m[1].length - 1;
      a = +m[2];
      b = +m[3];
      hunks.push({ header: l, lines: [] });
      continue;
    }
    hunks[hunks.length - 1]?.lines.push(l);
    if (l[0] === "\\") {
      const prev = body[body.length - 1];
      if (prev) prev.noeol = true;
      continue;
    }
    const prefix = l.slice(0, parents);
    const text = l.slice(parents);
    const inResult = !prefix.includes("-");
    if (!inResult) {
      if (prefix[0] === "-") body.push({ kind: "del", a: a++, text });
    } else if (prefix[0] === "+") body.push({ kind: "add", b: b++, text });
    else if (prefix[0] === " ") body.push({ kind: "ctx", a: a++, b: b++, text });
  }
  return { header, hunks, body, combined: parents > 1 };
}

/**
 * What a patch's file header lines say about the file.
 * @param {string[]} header
 */
function headerInfo(header) {
  let binary = false;
  let added = false;
  let deleted = false;
  /** @type {string | null} */ let oldMode = null;
  /** @type {string | null} */ let newMode = null;
  /** @type {string | null} */ let renameFrom = null;
  /** @type {number | null} */ let similarity = null;
  for (const h of header) {
    let m;
    if (/^Binary files .* differ$/.test(h)) binary = true;
    else if ((m = /^new file mode (\d+)/.exec(h))) { added = true; newMode = m[1]; }
    else if ((m = /^deleted file mode (\d+)/.exec(h))) { deleted = true; oldMode = m[1]; }
    else if ((m = /^old mode (\d+)/.exec(h))) oldMode = m[1];
    else if ((m = /^new mode (\d+)/.exec(h))) newMode = m[1];
    else if ((m = /^rename from (.*)/.exec(h))) renameFrom = m[1];
    else if ((m = /^similarity index (\d+)%/.exec(h))) similarity = +m[1];
  }
  return { binary, added, deleted, oldMode, newMode, renameFrom, similarity };
}

/**
 * The text of the Diff view's thin notice band, or null when there is nothing to say.
 * @param {DiffTarget} target @param {ReturnType<typeof headerInfo>} info
 */
function noticeFor(target, info) {
  const parts = [];
  if (info.binary) parts.push("Binary file changed");
  if (target.group === "untracked") parts.push("Untracked file: not yet tracked by Git");
  else if (info.added) parts.push("New file");
  else if (info.deleted) parts.push("Deleted file");
  else if (info.oldMode && info.newMode && info.oldMode !== info.newMode) parts.push(`Mode changed ${info.oldMode} → ${info.newMode}`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * @param {DiffTarget} target @param {ReturnType<typeof parsePatch>} patch
 */
function createDiffDocument(target, patch) {
  let adds = 0;
  let dels = 0;
  for (const l of patch.body) {
    if (l.kind === "add") adds++;
    else if (l.kind === "del") dels++;
  }
  const info = headerInfo(patch.header);
  const notice = noticeFor(target, info);
  /** @type {Map<string, ReturnType<typeof buildRows>>} */
  const cache = new Map();
  return Object.freeze({
    adds,
    dels,
    truncated: false,
    ...info,
    /** True for a Conflict's combined diff; its toPatch() is not appliable. */
    combined: patch.combined,
    notice,
    /** @param {import("./rows.js").RowMode} mode */
    rows(mode) {
      let rows = cache.get(mode);
      if (!rows) cache.set(mode, (rows = buildRows(patch.body, mode)));
      return rows;
    },
    /**
     * The patch exactly as git printed it: file header lines, raw hunk headers,
     * lines with their endings and `\ No newline at end of file`. A forward patch
     * from the left side to the right side (Phase 2 hunk staging applies it).
     */
    toPatch() {
      const out = [...patch.header];
      for (const h of patch.hunks) out.push(h.header, ...h.lines);
      return out.length ? out.join("\n") + "\n" : "";
    },
  });
}

/** @typedef {ReturnType<typeof createDiffDocument>} DiffDocument */
