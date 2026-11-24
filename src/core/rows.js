// @ts-check
// Display rows for a Diff view, built from a patch's body lines.

/** @typedef {import("./diff.js").PatchLine} PatchLine */
/**
 * One side of a split row. `line` is that side's line number.
 * `changed` (modified rows only) is the [start, end) of the part that differs from the other side.
 * @typedef {{ line: number, text: string, noeol?: true, changed?: [number, number] }} Half
 */
/**
 * A split row: both sides of one line. `left`/`right` is null for the empty half
 * of an unpaired deletion or addition. `block` numbers the change block a change row is in.
 * @typedef {{ kind: "ctx" | "mod" | "del" | "add", left: Half | null, right: Half | null, block?: number }} SplitRow
 */

/**
 * An inline row: one line of the file. `a`/`b` are its old/new line numbers
 * (context rows have both, a deletion only `a`, an addition only `b`).
 * `changed` (paired change lines only) is the [start, end) that differs from its pair.
 * @typedef {{ kind: "ctx" | "del" | "add", a?: number, b?: number, text: string, noeol?: true, changed?: [number, number], block?: number }} InlineRow
 */
/** @typedef {"split" | "inline"} RowMode */

/**
 * @template {RowMode} M
 * @param {PatchLine[]} body @param {M} mode
 * @returns {readonly (M extends "split" ? SplitRow : InlineRow)[]}
 */
export function buildRows(body, mode) {
  if (mode === "split") return /** @type {any} */ (Object.freeze(splitRows(body)));
  if (mode === "inline") return /** @type {any} */ (Object.freeze(inlineRows(body)));
  throw new Error(`Unsupported row mode ${mode}`);
}

/**
 * The row index of each change block's first row, in block order: where the
 * change navigator jumps to. Works for rows of either mode.
 * @param {readonly { block?: number }[]} rows
 * @returns {number[]}
 */
export function changeAnchors(rows) {
  const out = [];
  let last;
  rows.forEach((r, i) => {
    if (r.block !== undefined && r.block !== last) out.push(i);
    if (r.block !== undefined) last = r.block;
  });
  return out;
}

/**
 * The common prefix and suffix lengths of two lines; they never overlap.
 * What lies between them is the changed part.
 * @param {string} x @param {string} y
 */
export function intraline(x, y) {
  let prefix = 0;
  while (prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) prefix++;
  let suffix = 0;
  while (suffix < x.length - prefix && suffix < y.length - prefix && x[x.length - 1 - suffix] === y[y.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

/** @param {PatchLine} l @param {number} line @returns {Half} */
const half = (l, line) => (l.noeol ? { line, text: l.text, noeol: true } : { line, text: l.text });

/**
 * Walks the body as context lines and change blocks. A change block is a run of
 * deletions followed by a run of additions; both modes use these blocks.
 * @param {PatchLine[]} body
 * @param {(l: PatchLine) => void} onContext
 * @param {(dels: PatchLine[], adds: PatchLine[], block: number) => void} onBlock
 */
function walk(body, onContext, onBlock) {
  let block = 0;
  for (let i = 0; i < body.length;) {
    if (body[i].kind === "ctx") {
      onContext(body[i++]);
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < body.length && body[i].kind === "del") dels.push(body[i++]);
    while (i < body.length && body[i].kind === "add") adds.push(body[i++]);
    onBlock(dels, adds, block++);
  }
}

/**
 * The changed ranges of a paired deletion and addition (the i-th deletion of a
 * block pairs with its i-th addition), or null when the line is unpaired.
 * @param {PatchLine | undefined} d @param {PatchLine | undefined} a
 * @returns {{ del: [number, number], add: [number, number] } | null}
 */
function pairRanges(d, a) {
  if (!d || !a) return null;
  const { prefix, suffix } = intraline(d.text, a.text);
  return { del: [prefix, d.text.length - suffix], add: [prefix, a.text.length - suffix] };
}

/** @param {PatchLine[]} body */
function splitRows(body) {
  /** @type {SplitRow[]} */
  const out = [];
  walk(body,
    (l) => out.push({ kind: "ctx", left: half(l, l.a), right: half(l, l.b) }),
    (dels, adds, block) => {
      for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
        const d = dels[j];
        const a = adds[j];
        const left = d ? half(d, d.a) : null;
        const right = a ? half(a, a.b) : null;
        const ranges = pairRanges(d, a);
        if (left && right && ranges) {
          left.changed = ranges.del;
          right.changed = ranges.add;
        }
        out.push({ kind: left && right ? "mod" : left ? "del" : "add", left, right, block });
      }
    });
  return out;
}

/** @param {PatchLine[]} body */
function inlineRows(body) {
  /** @type {InlineRow[]} */
  const out = [];
  /** @param {PatchLine} l @param {Partial<InlineRow>} extra @returns {InlineRow} */
  const row = (l, extra) => {
    /** @type {InlineRow} */
    const r = { kind: l.kind, text: l.text };
    if (l.a !== undefined) r.a = l.a;
    if (l.b !== undefined) r.b = l.b;
    if (l.noeol) r.noeol = true;
    return Object.assign(r, extra);
  };
  walk(body,
    (l) => out.push(row(l, {})),
    (dels, adds, block) => {
      dels.forEach((d, j) => {
        const ranges = pairRanges(d, adds[j]);
        out.push(row(d, ranges ? { changed: ranges.del, block } : { block }));
      });
      adds.forEach((a, j) => {
        const ranges = pairRanges(dels[j], a);
        out.push(row(a, ranges ? { changed: ranges.add, block } : { block }));
      });
    });
  return out;
}
