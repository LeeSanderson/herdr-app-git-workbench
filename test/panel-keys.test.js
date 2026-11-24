import { test } from "node:test";
import assert from "node:assert/strict";
import { listKeyAction, listRows, moveSelection, settleSelection } from "../src/core/panel-keys.js";

const change = (path, group) => ({ path, status: group === "conflicts" ? "U" : group === "untracked" ? "?" : "M", group });

test("Space stages or unstages the row, and marks a Conflict resolved", () => {
  assert.equal(listKeyAction("space", change("a", "changes")), "toggle");
  assert.equal(listKeyAction("space", change("a", "untracked")), "toggle");
  assert.equal(listKeyAction("space", change("a", "staged")), "toggle");
  assert.equal(listKeyAction("space", change("a", "conflicts")), "toggle");
});

test("Enter opens the row's Diff view", () => {
  assert.equal(listKeyAction("enter", change("a", "changes")), "open");
  assert.equal(listKeyAction("enter", change("a", "staged")), "open");
});

test("Delete discards Changes and Untracked rows only", () => {
  assert.equal(listKeyAction("delete", change("a", "changes")), "discard");
  assert.equal(listKeyAction("delete", change("a", "untracked")), "discard");
  assert.equal(listKeyAction("delete", change("a", "staged")), null);
  assert.equal(listKeyAction("delete", change("a", "conflicts")), null);
});

test("Up/Down move and Tab goes to the commit box, with or without a selected row", () => {
  assert.equal(listKeyAction("up", null), "up");
  assert.equal(listKeyAction("down", null), "down");
  assert.equal(listKeyAction("tab", null), "commit-box");
  assert.equal(listKeyAction("down", change("a", "changes")), "down");
});

test("row keys do nothing without a selected row; other keys are not ours", () => {
  assert.equal(listKeyAction("space", null), null);
  assert.equal(listKeyAction("enter", null), null);
  assert.equal(listKeyAction("delete", null), null);
  assert.equal(listKeyAction("a", change("a", "changes")), null);
  assert.equal(listKeyAction("ctrl-enter", change("a", "changes")), null);
});

const groups = {
  conflicts: [change("c", "conflicts")],
  changes: [change("m", "changes")],
  untracked: [change("u", "untracked")],
  staged: [change("s", "staged"), change("t", "staged")],
};

test("rows run top to bottom as shown: Conflicts, Changes, Untracked, then Staged", () => {
  assert.deepEqual(listRows(groups).map((r) => r.key), ["conflicts:c", "changes:m", "untracked:u", "staged:s", "staged:t"]);
  assert.equal(listRows(groups)[0].change, groups.conflicts[0]);
});

test("Down from nothing selects the first row, Up from nothing the last", () => {
  const rows = listRows(groups);
  assert.deepEqual(moveSelection(rows, null, 1), { key: "conflicts:c", index: 0 });
  assert.deepEqual(moveSelection(rows, null, -1), { key: "staged:t", index: 4 });
});

test("moving stops at either end", () => {
  const rows = listRows(groups);
  assert.deepEqual(moveSelection(rows, { key: "changes:m", index: 1 }, 1), { key: "untracked:u", index: 2 });
  assert.deepEqual(moveSelection(rows, { key: "staged:t", index: 4 }, 1), { key: "staged:t", index: 4 });
  assert.deepEqual(moveSelection(rows, { key: "conflicts:c", index: 0 }, -1), { key: "conflicts:c", index: 0 });
  assert.equal(moveSelection([], null, 1), null);
});

test("a selected row that moved keeps its key; one that left keeps its place", () => {
  const rows = listRows(groups);
  // "staged:s" was at 1 before the refresh; it is now at 3.
  assert.deepEqual(settleSelection(rows, { key: "staged:s", index: 1 }), { key: "staged:s", index: 3 });
  // "changes:x" is gone (staged by Space): the row now at its place is selected.
  assert.deepEqual(settleSelection(rows, { key: "changes:x", index: 2 }), { key: "untracked:u", index: 2 });
  // Gone past the end: the last row.
  assert.deepEqual(settleSelection(rows, { key: "staged:z", index: 9 }), { key: "staged:t", index: 4 });
  assert.equal(settleSelection([], { key: "staged:z", index: 0 }), null);
  assert.equal(settleSelection(rows, null), null);
});
