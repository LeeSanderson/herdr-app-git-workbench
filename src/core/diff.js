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
  return createDiffDocument(parsePatch(r.stdout));
}

/**
 * Parses a single-file unified patch into its header lines and body lines.
 * @param {string} text
 */
export function parsePatch(text) {
  const raw = text.endsWith("\n") ? text.slice(0, -1) : text;
  const all = raw === "" ? [] : raw.split("\n");
  /** @type {string[]} */
  const header = [];
  /** @type {PatchLine[]} */
  const body = [];
  let i = 0;
  for (; i < all.length && !all[i].startsWith("@@"); i++) header.push(all[i]);
  let a = 0;
  let b = 0;
  for (; i < all.length; i++) {
    const l = all[i];
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) {
      a = +m[1];
      b = +m[2];
      continue;
    }
    const text = l.slice(1);
    switch (l[0]) {
      case " ": body.push({ kind: "ctx", a: a++, b: b++, text }); break;
      case "-": body.push({ kind: "del", a: a++, text }); break;
      case "+": body.push({ kind: "add", b: b++, text }); break;
      case "\\": {
        const prev = body[body.length - 1];
        if (prev) prev.noeol = true;
        break;
      }
    }
  }
  return { header, body };
}

/**
 * @param {{ header: string[], body: PatchLine[] }} patch
 */
function createDiffDocument(patch) {
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
    truncated: false,
    /** @param {"split"} mode */
    rows(mode) {
      let rows = cache.get(mode);
      if (!rows) cache.set(mode, (rows = buildRows(patch.body, mode)));
      return rows;
    },
  });
}

/** @typedef {ReturnType<typeof createDiffDocument>} DiffDocument */
