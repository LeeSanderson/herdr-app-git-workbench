// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutLanes } from "../mods/herdr-app-git-workbench/src/core/lanes.js";

/** A commit literal: `c("b", "a")` is b with parent a. @param {string} oid @param {...string} parents */
const c = (oid, ...parents) => ({ oid, parents });

/** Each row as `lane | incoming | outgoing`, with "." for a free slot. @param {ReturnType<typeof layoutLanes>} rows */
const picture = (rows) => rows.map((r) =>
  `${r.lane} | ${r.incoming.map((o) => o ?? ".").join(" ")} | ${r.outgoing.map((o) => o ?? ".").join(" ")}`);

test("linear history stays in lane 0 and ends at the root", () => {
  assert.deepEqual(picture(layoutLanes([c("c", "b"), c("b", "a"), c("a")])), [
    "0 |  | b",
    "0 | b | a",
    "0 | a | .",
  ]);
});

test("a fork: a second tip opens the next lane, and the shared parent closes it", () => {
  const rows = layoutLanes([c("f", "a"), c("m", "a"), c("a")]);
  assert.deepEqual(picture(rows), [
    "0 |  | a",
    "1 | a | a a",
    "0 | a a | . .",
  ]);
  assert.deepEqual(rows[2].merged, [1]);
});

test("a merge opens a lane for its second parent, which joins back at their common parent", () => {
  const rows = layoutLanes([c("m", "b", "x"), c("x", "a"), c("b", "a"), c("a")]);
  assert.deepEqual(picture(rows), [
    "0 |  | b x",
    "1 | b x | b a",
    "0 | b a | a a",
    "0 | a a | . .",
  ]);
  assert.deepEqual(rows[0].parentLanes, [0, 1]);
  assert.deepEqual(rows[3].merged, [1]);
});

test("an octopus merge opens one lane per extra parent", () => {
  const rows = layoutLanes([c("o", "a", "b", "c"), c("c", "r"), c("b", "r"), c("a", "r"), c("r")]);
  assert.deepEqual(picture(rows), [
    "0 |  | a b c",
    "2 | a b c | a b r",
    "1 | a b r | a r r",
    "0 | a r r | r r r",
    "0 | r r r | . . .",
  ]);
  assert.deepEqual(rows[0].parentLanes, [0, 1, 2]);
  assert.deepEqual(rows[4].merged, [1, 2]);
});

test("an extra parent already waited for joins that lane instead of opening one", () => {
  const rows = layoutLanes([c("f", "a"), c("m", "b", "a"), c("b", "a"), c("a")]);
  assert.deepEqual(rows[1].parentLanes, [1, 0]);
  assert.deepEqual(picture(rows)[1], "1 | a | a b");
});

test("a new lane reuses the first free slot", () => {
  assert.deepEqual(picture(layoutLanes([c("m", "b", "x"), c("x", "b"), c("b", "a"), c("t", "a"), c("a")])), [
    "0 |  | b x",
    "1 | b x | b b",
    "0 | b b | a .",
    "1 | a . | a a",
    "0 | a a | . .",
  ]);
});

test("lanes are never compacted: a lane keeps its column when a lane to its left ends", () => {
  assert.deepEqual(picture(layoutLanes([c("m", "b", "x"), c("b"), c("x", "y"), c("y")])), [
    "0 |  | b x",
    "0 | b x | . x",
    "1 | . x | . y",
    "1 | . y | . .",
  ]);
});

/** A merge-heavy history of `n` commits, newest first. */
function history(n) {
  const oldestFirst = [];
  for (let i = 0; i < n; i++) {
    const parents = i === 0 ? [] : [`c${i - 1}`];
    if (i % 5 === 4 && i >= 7) parents.push(`c${i - 7}`);
    if (i % 11 === 10) parents.push(`c${i - 3}`);
    oldestFirst.push(c(`c${i}`, ...parents));
  }
  // Extra tips that branch off older commits.
  oldestFirst.push(c("tip1", "c40"), c("tip2", "c90"));
  return oldestFirst.reverse();
}

test("prefix property: laying out N commits, then N+50, leaves the first N rows the same", () => {
  const all = history(120);
  for (const n of [1, 10, 50, 70]) {
    assert.deepEqual(layoutLanes(all.slice(0, n)), layoutLanes(all.slice(0, n + 50)).slice(0, n));
  }
});

test("the fold is deterministic", () => {
  assert.deepEqual(layoutLanes(history(120)), layoutLanes(history(120)));
});
