// @ts-check
// The Graph's lane layout: a pure fold over commits in topological order.
//
// A lane is a slot (a column) waiting for one oid. For each commit, in order:
// - it takes the first lane waiting for it; any other lanes waiting for it merge
//   into it at this row and close;
// - with no lane waiting (a Ref tip), it opens a lane in the first free slot, or
//   on the right when there is none;
// - its first parent continues in its lane; each extra parent joins a lane
//   already waiting for that parent, or opens one.
// Free slots are reused and lanes are never compacted, so a lane keeps its
// column (and colour) for as long as it exists. Row i depends only on commits
// 0..i, so laying out a longer history never changes rows already laid out.

/**
 * One row of the layout. `incoming` is the lanes above the commit's dot and
 * `outgoing` the lanes below it: each slot holds the oid that lane waits for, or
 * null when the slot is free. `parentLanes[k]` is the lane parent k continues in
 * (the first parent's is `lane`). `merged` lists the other lanes that waited for
 * this commit and close into its lane at this row.
 * @typedef {Readonly<{
 *   oid: string,
 *   lane: number,
 *   incoming: readonly (string | null)[],
 *   outgoing: readonly (string | null)[],
 *   parentLanes: readonly number[],
 *   merged: readonly number[],
 * }>} LaneRow
 */

/**
 * @param {readonly { oid: string, parents: readonly string[] }[]} commits newest first, topological order
 * @returns {LaneRow[]}
 */
export function layoutLanes(commits) {
  /** @type {(string | null)[]} */
  const lanes = [];
  const free = () => {
    const i = lanes.indexOf(null);
    return i >= 0 ? i : lanes.length;
  };
  return commits.map(({ oid, parents }) => {
    const incoming = Object.freeze(lanes.slice());
    const waiting = [];
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === oid) waiting.push(i);
    const lane = waiting.length ? waiting[0] : free();
    const merged = waiting.slice(1);
    for (const i of merged) lanes[i] = null;
    lanes[lane] = parents[0] ?? null;
    const parentLanes = parents.length ? [lane] : [];
    for (const parent of parents.slice(1)) {
      let j = lanes.indexOf(parent);
      if (j < 0 || j === lane) {
        j = free();
        lanes[j] = parent;
      }
      parentLanes.push(j);
    }
    return Object.freeze({
      oid,
      lane,
      incoming,
      outgoing: Object.freeze(lanes.slice()),
      parentLanes: Object.freeze(parentLanes),
      merged: Object.freeze(merged),
    });
  });
}

/** The number of slots a row's graph cell spans. @param {LaneRow} row */
export function rowWidth(row) {
  return Math.max(row.incoming.length, row.outgoing.length, row.lane + 1);
}
