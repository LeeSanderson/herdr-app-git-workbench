import { test } from "node:test";
import assert from "node:assert/strict";
import { graphKeyAction, moveGraphSelection, selectedItem, currentRow, pruneGraphSelection, nextRegion } from "../mods/herdr-app-git-workbench/src/core/graph-keys.js";
import { graphItems } from "../mods/herdr-app-git-workbench/src/core/graph-items.js";

const commit = (oid) => ({ key: `c:${oid}`, kind: "commit", oid, index: 0 });
const file = (oid, path) => ({ key: `f:${oid}:${path}`, kind: "file", oid, index: 0, file: { path, status: "M", oldPath: null } });

test("Right or Space expands a commit; Left collapses it; Enter toggles it", () => {
  assert.equal(graphKeyAction("right", commit("a")), "expand");
  assert.equal(graphKeyAction("space", commit("a")), "expand");
  assert.equal(graphKeyAction("left", commit("a")), "collapse");
  assert.equal(graphKeyAction("enter", commit("a")), "toggle");
});

test("on a file row Left goes up to its commit and Enter opens its Diff view", () => {
  assert.equal(graphKeyAction("left", file("a", "x.txt")), "parent");
  assert.equal(graphKeyAction("enter", file("a", "x.txt")), "open");
  assert.equal(graphKeyAction("right", file("a", "x.txt")), null);
  assert.equal(graphKeyAction("space", file("a", "x.txt")), null);
});

test("Up/Down move with or without a selection; row keys need one", () => {
  assert.equal(graphKeyAction("up", null), "up");
  assert.equal(graphKeyAction("down", null), "down");
  assert.equal(graphKeyAction("down", commit("a")), "down");
  for (const k of ["left", "right", "space", "enter"]) assert.equal(graphKeyAction(k, null), null);
  assert.equal(graphKeyAction("a", commit("a")), null);
  assert.equal(graphKeyAction("ctrl-enter", commit("a")), null);
});

// Three commits; "b" is expanded with two files, "c" is expanded and still loading.
const commits = [{ oid: "a" }, { oid: "b" }, { oid: "c" }];
const ready = (...paths) => ({ kind: "ready", files: paths.map((path) => ({ path, status: "M", oldPath: null })) });
const filesOf = (oid) => (oid === "b" ? ready("x.txt", "y.txt") : oid === "c" ? { kind: "loading" } : null);
const items = graphItems(commits, new Set(["b", "c"]), filesOf);
const at = (oid, path = null) => ({ oid, path });

test("Up/Down walk commit and file rows, skipping detail and status rows", () => {
  assert.deepEqual(moveGraphSelection(items, at("a"), 1), at("b"));
  assert.deepEqual(moveGraphSelection(items, at("b"), 1), at("b", "x.txt"));
  assert.deepEqual(moveGraphSelection(items, at("b", "x.txt"), 1), at("b", "y.txt"));
  assert.deepEqual(moveGraphSelection(items, at("b", "y.txt"), 1), at("c"));
  assert.deepEqual(moveGraphSelection(items, at("c"), -1), at("b", "y.txt"));
  assert.deepEqual(moveGraphSelection(items, at("b"), -1), at("a"));
});

test("moving stops at either end", () => {
  assert.deepEqual(moveGraphSelection(items, at("a"), -1), at("a"));
  assert.deepEqual(moveGraphSelection(items, at("c"), 1), at("c"));
  assert.equal(moveGraphSelection([], null, 1), null);
});

test("Down from nothing selects the first row, Up from nothing the last", () => {
  assert.deepEqual(moveGraphSelection(items, null, 1), at("a"));
  assert.deepEqual(moveGraphSelection(items, null, -1), at("c"));
});

test("the selected row: its item, or its commit once the file row is hidden, or none once the commit is gone", () => {
  assert.equal(selectedItem(items, at("b", "y.txt"))?.key, "f:b:y.txt");
  assert.equal(selectedItem(items, at("b"))?.key, "c:b");
  const collapsed = graphItems(commits, new Set(), filesOf);
  assert.equal(selectedItem(collapsed, at("b", "y.txt"))?.key, "c:b");
  assert.equal(selectedItem(collapsed, at("z")), null);
  assert.equal(selectedItem(items, null), null);
  // Moving from a hidden file row moves from its commit.
  assert.deepEqual(moveGraphSelection(collapsed, at("b", "y.txt"), 1), at("c"));
  // Moving from a vanished commit starts again from the end.
  assert.deepEqual(moveGraphSelection(collapsed, at("z"), 1), at("a"));
});

test("go to current selects HEAD's commit and gives its list index, wherever it is", () => {
  // Ref filter All: HEAD ("c") sits below another branch's commits and an expanded commit.
  assert.deepEqual(currentRow(items, "c"), { selection: at("c"), index: 5 });
  assert.deepEqual(currentRow(items, "a"), { selection: at("a"), index: 0 });
  assert.equal(currentRow(items, null), null);
  assert.equal(currentRow(items, "z"), null);
});

test("a reload drops a selection whose commit is gone and keeps the rest", () => {
  assert.deepEqual(pruneGraphSelection(at("b", "x.txt"), commits), at("b", "x.txt"));
  assert.deepEqual(pruneGraphSelection(at("a"), commits), at("a"));
  assert.equal(pruneGraphSelection(at("z"), commits), null);
  assert.equal(pruneGraphSelection(null, commits), null);
});

test("Tab cycles Change list → commit box → Graph, Shift+Tab the other way", () => {
  assert.equal(nextRegion("list", "tab"), "commit-box");
  assert.equal(nextRegion("commit-box", "tab"), "graph");
  assert.equal(nextRegion("graph", "tab"), "list");
  assert.equal(nextRegion("list", "shift-tab"), "graph");
  assert.equal(nextRegion("graph", "shift-tab"), "commit-box");
  assert.equal(nextRegion("commit-box", "shift-tab"), "list");
  assert.equal(nextRegion("commit-box", "ctrl-enter"), null);
  assert.equal(nextRegion("graph", "enter"), null);
});
