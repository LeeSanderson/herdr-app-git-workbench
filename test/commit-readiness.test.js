import { test } from "node:test";
import assert from "node:assert/strict";
import { commitReadiness } from "../src/core/commit.js";

const change = (path, group) => ({ path, status: group === "conflicts" ? "U" : "M", group });
const groups = ({ staged = 0, conflicts = 0 } = {}) => ({
  staged: Array.from({ length: staged }, (_, i) => change(`s${i}`, "staged")),
  changes: [change("edited", "changes")],
  untracked: [],
  conflicts: Array.from({ length: conflicts }, (_, i) => change(`c${i}`, "conflicts")),
});

test("ready: says how many staged files the commit takes", () => {
  assert.deepEqual(commitReadiness(groups({ staged: 2 }), "Fix it"), { ready: true, status: "2 file(s) ready" });
  assert.deepEqual(commitReadiness(groups({ staged: 1 }), "Fix it"), { ready: true, status: "1 file(s) ready" });
});

test("blocked by Conflicts first, whatever else is true", () => {
  assert.deepEqual(commitReadiness(groups({ staged: 1, conflicts: 2 }), "Merge"), { ready: false, status: "Resolve 2 conflict(s) first" });
  assert.deepEqual(commitReadiness(groups({ conflicts: 1 }), ""), { ready: false, status: "Resolve 1 conflict(s) first" });
});

test("blocked when nothing is staged", () => {
  assert.deepEqual(commitReadiness(groups(), "Fix it"), { ready: false, status: "Nothing staged" });
});

test("blocked when the message is empty or only whitespace", () => {
  assert.deepEqual(commitReadiness(groups({ staged: 3 }), ""), { ready: false, status: "3 file(s) ready. Write a commit message" });
  assert.deepEqual(commitReadiness(groups({ staged: 3 }), " \n\t"), { ready: false, status: "3 file(s) ready. Write a commit message" });
});
