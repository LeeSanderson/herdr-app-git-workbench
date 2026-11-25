// @ts-check
// The Graph toolbar's sync buttons: labels, counts, enabled and primary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { syncButtons } from "../src/core/sync.js";

/** A snapshot with only the fields the buttons read. */
const snap = (over = {}) => ({ upstream: "origin/main", ahead: 0, behind: 0, detached: false, operation: "none", running: null, ...over });

test("Fetch, Pull and Push are enabled while nothing runs, with their counts", () => {
  const b = syncButtons(snap({ ahead: 2, behind: 3 }));
  assert.deepEqual(b.fetch, { label: "Fetch", enabled: true, primary: false });
  assert.deepEqual(b.pull, { label: "Pull ↓3", enabled: true, primary: true });
  assert.deepEqual(b.push, { label: "Push ↑2", enabled: true, primary: false });
});

test("without an Upstream, Push becomes Publish", () => {
  const b = syncButtons(snap({ upstream: null, ahead: null, behind: null }));
  assert.deepEqual(b.push, { label: "Publish", enabled: true, primary: false });
});

test("a gone Upstream is still an Upstream: Push, not Publish", () => {
  const b = syncButtons(snap({ ahead: null, behind: null }));
  assert.equal(b.push.label, "Push");
});

test("a detached HEAD disables Push", () => {
  const b = syncButtons(snap({ detached: true, upstream: null, ahead: null, behind: null }));
  assert.deepEqual(b.push, { label: "Push", enabled: false, primary: false });
});

test("an Operation in progress disables Push", () => {
  const b = syncButtons(snap({ operation: "rebase", ahead: 1 }));
  assert.equal(b.push.enabled, false);
});

test("a running action disables Push", () => {
  const b = syncButtons(snap({ ahead: 1, running: { label: "Fetching…", timeoutClass: "long" } }));
  assert.equal(b.push.enabled, false);
});

test("Push is not primary when both ahead and behind, nor when only behind", () => {
  assert.equal(syncButtons(snap({ ahead: 1, behind: 1 })).push.primary, false);
  assert.equal(syncButtons(snap({ behind: 1 })).push.primary, false);
  assert.equal(syncButtons(snap()).push.primary, false);
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

test("a detached HEAD disables Pull", () => {
  const b = syncButtons(snap({ detached: true, upstream: null, ahead: null, behind: null }));
  assert.deepEqual(b.pull, { label: "Pull", enabled: false, primary: false });
});

test("an Operation in progress disables Pull", () => {
  const b = syncButtons(snap({ operation: "merge", behind: 2 }));
  assert.equal(b.pull.enabled, false);
});

test("no Upstream disables Pull", () => {
  const b = syncButtons(snap({ upstream: null, ahead: null, behind: null }));
  assert.equal(b.pull.enabled, false);
});

test("a running action disables Pull", () => {
  const b = syncButtons(snap({ behind: 1, running: { label: "Pushing…", timeoutClass: "long" } }));
  assert.equal(b.pull.enabled, false);
});

test("Pull is primary when behind, even when also ahead", () => {
  const b = syncButtons(snap({ ahead: 1, behind: 1 }));
  assert.equal(b.pull.primary, true);
  assert.equal(b.push.primary, false);
});