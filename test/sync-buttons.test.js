// @ts-check
// The Graph toolbar's sync buttons: labels, counts, enabled and primary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { syncButtons } from "../src/core/sync.js";

/** A snapshot with only the fields the buttons read. */
const snap = (over = {}) => ({ upstream: "origin/main", ahead: 0, behind: 0, detached: false, operation: "none", running: null, ...over });

test("Fetch is enabled while nothing runs; Pull and Push show their counts but stay disabled", () => {
  const b = syncButtons(snap({ ahead: 2, behind: 3 }));
  assert.deepEqual(b.fetch, { label: "Fetch", enabled: true, primary: false });
  assert.deepEqual(b.pull, { label: "Pull ↓3", enabled: false, primary: true });
  assert.deepEqual(b.push, { label: "Push ↑2", enabled: false, primary: false });
});

test("Push is primary when ahead and not behind", () => {
  const b = syncButtons(snap({ ahead: 1 }));
  assert.equal(b.push.primary, true);
  assert.equal(b.pull.primary, false);
  assert.equal(b.pull.label, "Pull ↓0");
});

test("without an Upstream there are no counts", () => {
  const b = syncButtons(snap({ upstream: null, ahead: null, behind: null }));
  assert.equal(b.pull.label, "Pull");
  assert.equal(b.push.label, "Push");
  assert.equal(b.pull.primary || b.push.primary, false);
});

test("a running action disables Fetch", () => {
  const b = syncButtons(snap({ running: { label: "Staging…", timeoutClass: "short" } }));
  assert.equal(b.fetch.enabled, false);
});

test("a detached HEAD or an Operation in progress leaves Fetch enabled", () => {
  assert.equal(syncButtons(snap({ detached: true, upstream: null, ahead: null, behind: null })).fetch.enabled, true);
  assert.equal(syncButtons(snap({ operation: "merge" })).fetch.enabled, true);
});
