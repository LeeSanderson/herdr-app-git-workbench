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
 * @param {PatchLine[]} body @param {"split"} mode
 * @returns {readonly SplitRow[]}
 */
export function buildRows(body, mode) {
  if (mode !== "split") throw new Error(`Unsupported row mode ${mode}`);
  return Object.freeze(splitRows(body));
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

/** @param {PatchLine[]} body */
function splitRows(body) {
  /** @type {SplitRow[]} */
  const out = [];
  let block = 0;
  for (let i = 0; i < body.length;) {
    const l = body[i];
    if (l.kind === "ctx") {
      out.push({ kind: "ctx", left: half(l, l.a), right: half(l, l.b) });
      i++;
      continue;
    }
    // A change block: a run of deletions followed by a run of additions.
    // The i-th deletion pairs with the i-th addition.
    const dels = [];
    const adds = [];
    while (i < body.length && body[i].kind === "del") dels.push(body[i++]);
    while (i < body.length && body[i].kind === "add") adds.push(body[i++]);
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
      const d = dels[j];
      const a = adds[j];
      const left = d ? half(d, d.a) : null;
      const right = a ? half(a, a.b) : null;
      if (left && right) {
        const { prefix, suffix } = intraline(left.text, right.text);
        left.changed = [prefix, left.text.length - suffix];
        right.changed = [prefix, right.text.length - suffix];
      }
      out.push({ kind: left && right ? "mod" : left ? "del" : "add", left, right, block });
    }
    block++;
  }
  return out;
}
