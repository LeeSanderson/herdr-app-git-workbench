// @ts-check
// How a raw diff line is shown: tabs expanded to 4-column stops and a CR shown
// as ␍, so whitespace changes stay visible. Pure; the Diff view renders the result.

const TAB = 4;

/**
 * Splits a raw line into display segments: tabs expanded to 4-column stops
 * (counted from the line start, across segments), a CR shown as ␍, and the
 * `changed` range [start, end) of the raw text marked `hl`. Empty segments are left out.
 * @param {string} text @param {[number, number] | undefined} changed
 * @returns {{ s: string, hl: boolean }[]}
 */
export function displaySegments(text, changed) {
  /** @type {[number, number, boolean][]} */
  const cuts = changed
    ? [[0, changed[0], false], [changed[0], changed[1], true], [changed[1], text.length, false]]
    : [[0, text.length, false]];
  let col = 0;
  const out = [];
  for (const [from, to, hl] of cuts) {
    let s = "";
    for (let i = from; i < to; i++) {
      const c = text[i];
      if (c === "\t") {
        const n = TAB - (col % TAB);
        s += " ".repeat(n);
        col += n;
      } else {
        s += c === "\r" ? "␍" : c;
        col++;
      }
    }
    if (s) out.push({ s, hl });
  }
  return out;
}
