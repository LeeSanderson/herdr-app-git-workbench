import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlaceTracker } from "../mods/herdr-app-git-workbench/src/core/follow-place.js";

const HOME = "C:\\Users\\me";
const space = (id, folder, { active = false, machine = null, tabs = [] } = {}) => ({ id, folder, machine, active, tabs });
const tab = (id, active = false) => ({ id, active });
const focus = (spaceId, cwd) => ({ space: spaceId, cwd });
const terminal = (tabId, cwd) => ({ tab: tabId, terminal: `t-${tabId}-${cwd}`, cwd });
const modPane = (tabId) => ({ tab: tabId, terminal: null, cwd: null });

test("follows the shown space's folder when no terminal there has had focus", () => {
  const tracker = createPlaceTracker();
  const spaces = [space("a", "C:\\Dev\\started-here", { active: true })];
  assert.deepEqual(tracker.whereToFollow(spaces, null, [], HOME), { machine: null, folder: "C:\\Dev\\started-here" });
});

test("follows the focused terminal's folder once it has moved away from where the space started", () => {
  const tracker = createPlaceTracker();
  const spaces = [space("a", "C:\\Dev\\started-here", { active: true })];
  assert.deepEqual(tracker.whereToFollow(spaces, focus("a", "C:\\Dev\\moved-here"), [], HOME), { machine: null, folder: "C:\\Dev\\moved-here" });
});

test("keeps following that folder while a mod pane (no cwd) has focus", () => {
  const tracker = createPlaceTracker();
  const spaces = [space("a", "C:\\Dev\\started-here", { active: true })];
  tracker.whereToFollow(spaces, focus("a", "C:\\Dev\\moved-here"), [], HOME);
  assert.deepEqual(tracker.whereToFollow(spaces, focus("a", null), [], HOME), { machine: null, folder: "C:\\Dev\\moved-here" });
});

test("remembers each space's last focused folder separately", () => {
  const tracker = createPlaceTracker();
  const inA = [space("a", "C:\\a", { active: true }), space("b", "C:\\b")];
  const inB = [space("a", "C:\\a"), space("b", "C:\\b", { active: true })];
  tracker.whereToFollow(inA, focus("a", "C:\\a\\moved"), [], HOME);
  assert.deepEqual(tracker.whereToFollow(inB, focus("b", null), [], HOME), { machine: null, folder: "C:\\b" });
  assert.deepEqual(tracker.whereToFollow(inA, focus("a", null), [], HOME), { machine: null, folder: "C:\\a\\moved" });
});

test("ignores focus reported for a space other than the shown one", () => {
  const tracker = createPlaceTracker();
  const spaces = [space("a", "C:\\a", { active: true }), space("b", "C:\\b")];
  assert.deepEqual(tracker.whereToFollow(spaces, focus("b", "C:\\b\\elsewhere"), [], HOME), { machine: null, folder: "C:\\a" });
});

test("an empty space folder means home: this computer's, or the remote machine's own (\"\")", () => {
  const tracker = createPlaceTracker();
  assert.deepEqual(tracker.whereToFollow([space("a", "", { active: true })], null, [], HOME), { machine: null, folder: HOME });
  assert.deepEqual(tracker.whereToFollow([space("r", "", { active: true, machine: "box" })], null, [], HOME), { machine: "box", folder: "" });
});

test("follows nothing when no space is shown", () => {
  assert.equal(createPlaceTracker().whereToFollow([space("a", "C:\\a")], null, [], HOME), null);
});

test("before any terminal there has had focus, follows where the space's terminals are now, shown tab first", () => {
  const tracker = createPlaceTracker();
  const spaces = [space("a", "C:\\Dev\\started-here", { active: true, tabs: [tab("t1"), tab("t2", true)] })];
  const panes = [terminal("t1", "C:\\Dev\\first-tab"), modPane("t2"), terminal("t2", "C:\\Dev\\shown-tab"), terminal("other", "C:\\x")];
  assert.deepEqual(tracker.whereToFollow(spaces, focus("a", null), panes, HOME), { machine: null, folder: "C:\\Dev\\shown-tab" });
});

test("a terminal that has had focus wins over the space's other terminals", () => {
  const tracker = createPlaceTracker();
  const spaces = [space("a", "C:\\a", { active: true, tabs: [tab("t1", true)] })];
  const panes = [terminal("t1", "C:\\a\\first"), terminal("t1", "C:\\a\\second")];
  tracker.whereToFollow(spaces, focus("a", "C:\\a\\second"), panes, HOME);
  assert.deepEqual(tracker.whereToFollow(spaces, focus("a", null), panes, HOME), { machine: null, folder: "C:\\a\\second" });
});

test("forgets a closed space's folder", () => {
  const tracker = createPlaceTracker();
  tracker.whereToFollow([space("a", "C:\\a", { active: true })], focus("a", "C:\\a\\moved"), [], HOME);
  tracker.whereToFollow([space("b", "C:\\b", { active: true })], null, [], HOME);
  assert.deepEqual(tracker.whereToFollow([space("a", "C:\\a", { active: true })], null, [], HOME), { machine: null, folder: "C:\\a" });
});
