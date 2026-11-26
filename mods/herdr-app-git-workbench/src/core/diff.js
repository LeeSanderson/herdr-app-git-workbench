// @ts-check
// Loading a Diff target into a DiffDocument: runs `git diff` for the whole file
// and parses the patch into a line model. Rows for display come from rows.js.

import { buildRows } from "./rows.js";
import { actionError } from "./errors.js";

/** @typedef {ReturnType<import("./git.js").createGit>} Git */
/** @typedef {import("./diff-target.js").DiffTarget} DiffTarget */
/**
 * One line of the patch body. `a`/`b` are old/new line numbers; `text` is raw
 * (no prefix, no newline; a CR of a CRLF line is kept for the UI to show).
 * @typedef {{ kind: "ctx" | "del" | "add", a?: number, b?: number, text: string, noeol?: true }} PatchLine
 */

/**
 * A run of unchanged lines left out of a truncated diff (see LINE_LIMIT), before
 * the hunk that follows it or after the last hunk. `a`/`b` are the old/new numbers
 * of its first line; `title` is git's function context of the following hunk ("" after the last).
 * @typedef {{ kind: "gap", a: number, b: number, count: number, title: string }} GapLine
 */

/** Whole file: more context than any file has lines. */
const WHOLE_FILE = "-U99999999";
/** Changed sections only: git's default context. */
const SECTIONS = "-U3";
/** Files whose larger side has more lines than this show only the changed sections. */
export const LINE_LIMIT = 5000;
const DIFF_FLAGS = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];

/**
 * What loading a Diff target gives: its document, or why Git couldn't diff it.
 * @typedef {{ ok: true, doc: DiffDocument } | { ok: false, error: import("./errors.js").ActionError }} DiffResult
 */

/**
 * The `git diff` arguments for a target's sides, or null for sides Phase 1 never
 * makes. Paths always follow "--".
 * @param {DiffTarget} t @param {string} context WHOLE_FILE or SECTIONS
 * @returns {string[] | null}
 */
function diffArgs(t, context) {
  const flags = [...DIFF_FLAGS, context];
  const paths = t.oldPath !== t.newPath ? [t.oldPath, t.newPath] : [t.newPath];
  if (isCommit(t.right)) {
    // A root commit (or shallow boundary) against empty content: diff-tree --root.
    if (t.left === "EMPTY") return ["diff-tree", "-p", "--root", "--no-commit-id", ...flags.slice(1), "-M", t.right, "--", t.newPath];
    if (isCommit(t.left)) return [...flags, "-M", t.left, t.right, "--", ...paths];
    return null;
  }
  if (t.left === "EMPTY") return [...flags, "--no-index", "--", "/dev/null", t.newPath];
  if (t.left === "HEAD" && t.right === "INDEX") {
    return [...flags, "--cached", "-M", "--", ...paths];
  }
  if (t.left === "INDEX" && t.right === "WORKTREE") return [...flags, "--", t.newPath];
  return null;
}

/** Whether a side is a commit oid (not HEAD, the index, the worktree or empty). @param {string} side */
const isCommit = (side) => /^[0-9a-f]{40,64}$/.test(side);

/**
 * The `git grep` arguments that count one side's lines (binary files count 0).
 * `git grep -c` prints "<rev>:<path>:<count>" and exits 1 when nothing matches.
 * @param {string} side @param {string} path
 * @returns {string[] | null} null for the EMPTY side
 */
function countArgs(side, path) {
  const grep = ["grep", "-c", "-I"];
  if (side === "EMPTY") return null;
  if (side === "INDEX") return [...grep, "--cached", "-e", "", "--", path];
  if (side === "WORKTREE") return [...grep, "--no-index", "-e", "", "--", path];
  return [...grep, "-e", "", side, "--", path]; // HEAD or a commit
}

/**
 * The number of lines on one side of a target (0 when it can't be counted).
 * @param {Git} git @param {DiffTarget} target @param {"left" | "right"} which
 */
async function lineCount(git, target, which) {
  const args = countArgs(target[which], which === "left" ? target.oldPath : target.newPath);
  if (!args) return 0;
  const { machine, toplevel } = target.repository;
  const r = await git.run(machine, args, { cwd: toplevel, read: true });
  const m = /:(\d+)\s*$/.exec(r.stdout);
  return m ? +m[1] : 0;
}

/**
 * Loads a Diff target. Reads run straight through the Git runner, not the
 * Repository's queue, so a diff never waits behind a stage or commit.
 * When the larger side has more than LINE_LIMIT lines, only the changed
 * sections load (`truncated`), with gap rows for the unchanged lines between them.
 * Errors are values: a failed diff resolves `{ ok: false, error }`; only
 * GitNotFound and GitTimeout reject.
 * @param {Git} git @param {DiffTarget} target
 * @returns {Promise<DiffResult>}
 */
export async function loadDiff(git, target) {
  const { machine, toplevel } = target.repository;
  const [oldLines, newLines] = await Promise.all([lineCount(git, target, "left"), lineCount(git, target, "right")]);
  const lines = Math.max(oldLines, newLines);
  const truncated = lines > LINE_LIMIT;
  const args = diffArgs(target, truncated ? SECTIONS : WHOLE_FILE);
  if (!args) {
    const message = `Unsupported Diff target sides ${target.left}→${target.right}`;
    return { ok: false, error: { summary: message, detail: message } };
  }
  const r = await git.run(machine, args, { cwd: toplevel, read: true });
  // `--no-index` exits 1 when the files differ; anything above that is an error.
  const failed = args.includes("--no-index") ? r.code > 1 || r.code < 0 : !r.ok;
  if (failed) return { ok: false, error: actionError(r.stderr, "git diff failed") };
  return { ok: true, doc: createDiffDocument(target, parsePatch(r.stdout, truncated ? oldLines : undefined), { truncated, lines }) };
}

/**
 * Parses a single-file unified patch into its file header lines, its hunks
 * (raw hunk header plus raw lines, exactly as git printed them, for toPatch())
 * and its body lines. Unchanged lines left out between hunks become GapLines;
 * pass the old side's line count to also get the gap after the last hunk.
 * @param {string} text @param {number} [oldLines]
 */
export function parsePatch(text, oldLines) {
  const raw = text.endsWith("\n") ? text.slice(0, -1) : text;
  const all = raw === "" ? [] : raw.split("\n");
  /** @type {string[]} */
  const header = [];
  /** @type {{ header: string, lines: string[] }[]} */
  const hunks = [];
  /** @type {(PatchLine | GapLine)[]} */
  const body = [];
  let i = 0;
  for (; i < all.length && !all[i].startsWith("@@"); i++) header.push(all[i]);
  // A combined diff (a Conflict) has one prefix column per parent and `@@@`
  // hunk headers. Its body is read as a diff from the first parent (HEAD's
  // side, "ours") to the result: column 1 decides, and lines that only another
  // parent had are left out of the body (they stay in the raw hunk).
  let parents = 1;
  // The next old/new line numbers; lines before a hunk's start were left out.
  let a = 1;
  let b = 1;
  for (; i < all.length; i++) {
    const l = all[i];
    const m = /^(@@+) -(\d+)(?:,(\d+))?(?: -\d+(?:,\d+)?)* \+(\d+)(?:,(\d+))? \1 ?(.*)$/.exec(l);
    if (m) {
      parents = m[1].length - 1;
      // An empty range "-5,0" names the line before it.
      const start = (/** @type {string} */ n, /** @type {string | undefined} */ len) => (len === "0" ? +n + 1 : +n);
      const oldStart = start(m[2], m[3]);
      if (oldStart > a) body.push({ kind: "gap", a, b, count: oldStart - a, title: m[6].trim() });
      a = oldStart;
      b = start(m[4], m[5]);
      hunks.push({ header: l, lines: [] });
      continue;
    }
    hunks[hunks.length - 1]?.lines.push(l);
    if (l[0] === "\\") {
      const prev = body[body.length - 1];
      if (prev && prev.kind !== "gap") prev.noeol = true;
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
  if (hunks.length && oldLines !== undefined && oldLines >= a) body.push({ kind: "gap", a, b, count: oldLines - a + 1, title: "" });
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
 * @param {{ truncated: boolean, lines: number }} size
 */
function noticeFor(target, info, size) {
  const parts = [];
  if (info.binary) parts.push("Binary file changed");
  if (target.group === "untracked") parts.push("Untracked file: not yet tracked by Git");
  else if (info.added) parts.push("New file");
  else if (info.deleted) parts.push("Deleted file");
  else if (info.oldMode && info.newMode && info.oldMode !== info.newMode) parts.push(`Mode changed ${info.oldMode} → ${info.newMode}`);
  if (size.truncated) parts.push(`Only the changed sections are shown: this file has ${thousands(size.lines)} lines, over the ${thousands(LINE_LIMIT)}-line limit`);
  return parts.length ? parts.join(" · ") : null;
}

/** 12345 → "12,345" (no Intl in every runtime). @param {number} n */
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * @param {DiffTarget} target @param {ReturnType<typeof parsePatch>} patch
 * @param {{ truncated: boolean, lines: number }} size `lines` is the larger side's line count
 */
function createDiffDocument(target, patch, size) {
  let adds = 0;
  let dels = 0;
  for (const l of patch.body) {
    if (l.kind === "add") adds++;
    else if (l.kind === "del") dels++;
  }
  const info = headerInfo(patch.header);
  const notice = noticeFor(target, info, size);
  /** @type {Map<string, ReturnType<typeof buildRows>>} */
  const cache = new Map();
  return Object.freeze({
    adds,
    dels,
    /** True when only the changed sections loaded (the file is over LINE_LIMIT lines). */
    truncated: size.truncated,
    /** The larger side's line count (0 for binary files). */
    lines: size.lines,
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
