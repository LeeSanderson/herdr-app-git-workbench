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
 * @param {DiffTarget} t @param {string} context WHOLE_FILE or SECTIONS
 */
function diffArgs(t, context) {
  const flags = [...DIFF_FLAGS, context];
  if (t.left === "EMPTY") return [...flags, "--no-index", "--", "/dev/null", t.newPath];
  if (t.left === "HEAD" && t.right === "INDEX") {
    const paths = t.oldPath !== t.newPath ? [t.oldPath, t.newPath] : [t.newPath];
    return [...flags, "--cached", "-M", "--", ...paths];
  }
  if (t.left === "INDEX" && t.right === "WORKTREE") return [...flags, "--", t.newPath];
  throw new Error(`Unsupported Diff target sides ${t.left}→${t.right}`);
}

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
 * @param {Git} git @param {DiffTarget} target
 */
export async function loadDiff(git, target) {
  const { machine, toplevel } = target.repository;
  const [oldLines, newLines] = await Promise.all([lineCount(git, target, "left"), lineCount(git, target, "right")]);
  const lines = Math.max(oldLines, newLines);
  const truncated = lines > LINE_LIMIT;
  const r = await git.run(machine, diffArgs(target, truncated ? SECTIONS : WHOLE_FILE), { cwd: toplevel, read: true });
  // `--no-index` exits 1 when the files differ; anything above that is an error.
  const failed = target.left === "EMPTY" ? r.code > 1 || r.code < 0 : !r.ok;
  if (failed) {
    const detail = r.stderr.trim();
    throw new DiffLoadError(detail.split("\n")[0] || "git diff failed", detail);
  }
  return createDiffDocument(parsePatch(r.stdout, truncated ? oldLines : undefined), { truncated, lines });
}

/**
 * Parses a single-file unified patch into its header lines and body lines.
 * Unchanged lines between hunks become GapLines. Pass the old side's line count
 * to also get the gap after the last hunk.
 * @param {string} text @param {number} [oldLines]
 */
export function parsePatch(text, oldLines) {
  const raw = text.endsWith("\n") ? text.slice(0, -1) : text;
  const all = raw === "" ? [] : raw.split("\n");
  /** @type {string[]} */
  const header = [];
  /** @type {(PatchLine | GapLine)[]} */
  const body = [];
  let i = 0;
  for (; i < all.length && !all[i].startsWith("@@"); i++) header.push(all[i]);
  // The next old/new line numbers; lines before a hunk's start were left out.
  let a = 1;
  let b = 1;
  let hunks = 0;
  for (; i < all.length; i++) {
    const l = all[i];
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(l);
    if (m) {
      hunks++;
      // An empty range "-5,0" names the line before it.
      const start = (/** @type {string} */ n, /** @type {string | undefined} */ len) => (len === "0" ? +n + 1 : +n);
      const oldStart = start(m[1], m[2]);
      if (oldStart > a) body.push({ kind: "gap", a, b, count: oldStart - a, title: m[5].trim() });
      a = oldStart;
      b = start(m[3], m[4]);
      continue;
    }
    const text = l.slice(1);
    switch (l[0]) {
      case " ": body.push({ kind: "ctx", a: a++, b: b++, text }); break;
      case "-": body.push({ kind: "del", a: a++, text }); break;
      case "+": body.push({ kind: "add", b: b++, text }); break;
      case "\\": {
        const prev = body[body.length - 1];
        if (prev && prev.kind !== "gap") prev.noeol = true;
        break;
      }
    }
  }
  if (hunks && oldLines !== undefined && oldLines >= a) body.push({ kind: "gap", a, b, count: oldLines - a + 1, title: "" });
  return { header, body };
}

/**
 * @param {{ header: string[], body: (PatchLine | GapLine)[] }} patch
 * @param {{ truncated: boolean, lines: number }} size `lines` is the larger side's line count
 */
function createDiffDocument(patch, { truncated, lines }) {
  let adds = 0;
  let dels = 0;
  for (const l of patch.body) {
    if (l.kind === "add") adds++;
    else if (l.kind === "del") dels++;
  }
  /** @type {Map<string, ReturnType<typeof buildRows>>} */
  const cache = new Map();
  return Object.freeze({
    adds,
    dels,
    /** True when only the changed sections loaded (the file is over LINE_LIMIT lines). */
    truncated,
    lines,
    /** @param {import("./rows.js").RowMode} mode */
    rows(mode) {
      let rows = cache.get(mode);
      if (!rows) cache.set(mode, (rows = buildRows(patch.body, mode)));
      return rows;
    },
  });
}

/** @typedef {ReturnType<typeof createDiffDocument>} DiffDocument */
