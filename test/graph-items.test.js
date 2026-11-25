// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { graphItems } from "../src/core/graph-items.js";

const commit = (/** @type {string} */ oid) => ({ oid, parents: [] });
const commits = [commit("a"), commit("b"), commit("c")];

test("collapsed commits are one row each", () => {
  const items = graphItems(commits, new Set(), () => null);
  assert.deepEqual(items.map((i) => i.key), ["c:a", "c:b", "c:c"]);
});

test("an expanded commit is followed by its detail block and one row per file", () => {
  const files = { b: { kind: "ready", files: [{ status: "M", path: "x.txt" }, { status: "A", path: "d/y.txt" }] } };
  const items = graphItems(commits, new Set(["b"]), (oid) => files[oid] ?? null);
  assert.deepEqual(items.map((i) => i.key), ["c:a", "c:b", "d:b", "f:b:x.txt", "f:b:d/y.txt", "c:c"]);
  const file = items[3];
  assert.equal(file.kind, "file");
  assert.equal(file.index, 1, "the commit's index, for its lanes");
  assert.deepEqual(file.kind === "file" && file.file, { status: "M", path: "x.txt" });
});

test("an expanded commit whose files are loading or failed shows one status row", () => {
  const error = { summary: "bad tree", detail: "bad tree" };
  const files = { a: { kind: "loading" }, c: { kind: "error", error } };
  const items = graphItems(commits, new Set(["a", "c"]), (oid) => files[oid] ?? null);
  assert.deepEqual(items.map((i) => i.key), ["c:a", "d:a", "s:a", "c:b", "c:c", "d:c", "s:c"]);
  const failed = items[6];
  assert.deepEqual(failed.kind === "status" && failed.files, { kind: "error", error });
});
