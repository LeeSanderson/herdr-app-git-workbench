import { test } from "node:test";
import assert from "node:assert/strict";
import { createChangeCursor } from "../mods/herdr-app-git-workbench/src/core/change-cursor.js";

test("the first load with changes goes to Change 1", () => {
  const cursor = createChangeCursor();
  assert.equal(cursor.current, -1);
  assert.equal(cursor.loaded(3), true);
  assert.equal(cursor.current, 0);
});

test("a reload keeps the cursor on the change you moved to", () => {
  const cursor = createChangeCursor();
  cursor.loaded(3);
  cursor.go(1, 3);
  assert.equal(cursor.current, 1);
  assert.equal(cursor.loaded(3), false);
  assert.equal(cursor.current, 1);
});

test("a first load with no changes goes nowhere, and later loads don't jump either", () => {
  const cursor = createChangeCursor();
  assert.equal(cursor.loaded(0), false);
  assert.equal(cursor.current, -1);
  assert.equal(cursor.loaded(2), false);
  assert.equal(cursor.current, -1);
});

test("next and previous wrap around the changes", () => {
  const cursor = createChangeCursor();
  cursor.loaded(3);
  cursor.go(-1, 3);
  assert.equal(cursor.current, 2);
  cursor.go(1, 3);
  assert.equal(cursor.current, 0);
});

test("before any change is current, previous goes to the last one", () => {
  const cursor = createChangeCursor();
  cursor.loaded(0);
  assert.equal(cursor.go(-1, 4), true);
  assert.equal(cursor.current, 3);
});

test("with no changes there is nowhere to go", () => {
  const cursor = createChangeCursor();
  assert.equal(cursor.go(1, 0), false);
  assert.equal(cursor.current, -1);
});
