// @ts-check
// Opening Diff views in Herdr tabs, one tab per Diff target.
//
// The registry (Diff target key → tab id) lives at module scope, so the panel and
// every Diff view share it. It is lost on hot reload; a Diff target opened after a
// reload gets a new tab. Tabs are never matched by name.
//
// `run("tab.new")` returns null, so the new tab's id is read from `focused()` right
// after the call (new tabs take focus). A Diff view also claims its own tab when it
// starts, in case `focused()` hadn't caught up yet. UNVERIFIED in the app.

import { run, focused, spaces, panes } from "herdr";
import { targetKey, tabName } from "../core/diff-target.js";

export const MOD = "herdr-app-git-workbench";

/** @type {Map<string, string>} Diff target key → tab id */
const tabs = new Map();

/** @param {string} id */
const tabExists = (id) => spaces().some((s) => s.tabs.some((t) => t.id === id));

/**
 * Selects the Diff target's open tab, or opens a new Diff view tab for it.
 * @param {import("../core/diff-target.js").DiffTarget} target
 */
export function openDiff(target) {
  const key = targetKey(target);
  const known = tabs.get(key);
  if (known && tabExists(known)) {
    run("tab.select", { id: known });
    return;
  }
  tabs.delete(key);
  const before = focused()?.tab ?? null;
  run("tab.new", { name: tabName(target), mod: MOD, props: { view: "diff", diff: target }, focus: true });
  const after = focused()?.tab ?? null;
  if (after && after !== before && !isRegistered(after)) tabs.set(key, after);
}

/**
 * Called by a starting Diff view: if its target has no live tab yet, claim the one
 * tab of this mod that no target owns. Does nothing when that is ambiguous.
 * @param {import("../core/diff-target.js").DiffTarget} target
 */
export function claimTab(target) {
  const key = targetKey(target);
  const known = tabs.get(key);
  if (known && tabExists(known)) return;
  const unowned = [...new Set(panes().filter((p) => p.mod === MOD).map((p) => p.tab))].filter((t) => !isRegistered(t));
  // The docked panel is a layout block, not a tab pane, so it isn't listed by tab here
  // unless the panel was opened in a tab; then the guess is ambiguous and we skip it.
  if (unowned.length === 1) tabs.set(key, unowned[0]);
}

/** @param {string} tabId */
function isRegistered(tabId) {
  for (const id of tabs.values()) if (id === tabId) return true;
  return false;
}
