// @ts-check
// The Graph's keys: which row is selected, and what a key does to it.
// Herdr-free so it can be tested; the panel maps the actions onto its own calls.
// Beside the Change list's key logic in panel-keys.js.

/** @typedef {import("./graph-items.js").GraphItem} GraphItem */
/** @typedef {"up" | "down" | "expand" | "collapse" | "parent" | "toggle" | "open"} GraphKeyAction */
/**
 * The selected Graph row, tracked by oid (plus path for a file row) so it
 * survives reloads, expanding and collapsing.
 * @typedef {Readonly<{ oid: string, path: string | null }>} GraphSelection
 */

/** Rows the selection can rest on: commits and files (not detail or status rows). @param {GraphItem} it */
const selectable = (it) => it.kind === "commit" || it.kind === "file";

/** @param {GraphItem} it @returns {GraphSelection} */
const selectionOf = (it) => Object.freeze({ oid: it.oid, path: it.kind === "file" ? it.file.path : null });

/**
 * The visible row the selection rests on: its file row, or its commit while the
 * file row is hidden (collapsed, or files not loaded), or null once the commit is gone.
 * @param {readonly GraphItem[]} items @param {GraphSelection | null} selection
 * @returns {GraphItem | null}
 */
export function selectedItem(items, selection) {
  if (!selection) return null;
  const { oid, path } = selection;
  const file = path === null ? undefined : items.find((it) => it.kind === "file" && it.oid === oid && it.file.path === path);
  return file ?? items.find((it) => it.kind === "commit" && it.oid === oid) ?? null;
}

/**
 * Moves the selection by `delta` commit or file rows, stopping at either end.
 * With nothing (visible) selected, Down picks the first row and Up the last.
 * @param {readonly GraphItem[]} items @param {GraphSelection | null} selection @param {1 | -1} delta
 * @returns {GraphSelection | null}
 */
export function moveGraphSelection(items, selection, delta) {
  const rows = items.filter(selectable);
  if (!rows.length) return null;
  const current = selectedItem(items, selection);
  const at = current ? rows.indexOf(current) : -1;
  const index = at >= 0 ? Math.min(rows.length - 1, Math.max(0, at + delta)) : delta > 0 ? 0 : rows.length - 1;
  return selectionOf(rows[index]);
}

/**
 * Go to current: the selection on the HEAD commit's row and that row's index in
 * `items` (to scroll to). Null when HEAD isn't shown.
 * @param {readonly GraphItem[]} items @param {string | null} head
 * @returns {{ selection: GraphSelection, index: number } | null}
 */
export function currentRow(items, head) {
  if (head === null) return null;
  const index = items.findIndex((it) => it.kind === "commit" && it.oid === head);
  return index < 0 ? null : { selection: selectionOf(items[index]), index };
}

/**
 * The selection after a reload: kept while its commit is still shown, else
 * dropped quietly (an amend or rebase rewrote it).
 * @param {GraphSelection | null} selection @param {readonly { oid: string }[]} commits
 * @returns {GraphSelection | null}
 */
export function pruneGraphSelection(selection, commits) {
  return selection && commits.some((c) => c.oid === selection.oid) ? selection : null;
}

/** @typedef {"list" | "commit-box" | "graph"} FocusRegion */
/** @type {readonly FocusRegion[]} */
const REGIONS = ["list", "commit-box", "graph"];

/**
 * The panel's focus cycle: Tab goes Change list → commit box → Graph → Change
 * list, Shift+Tab the other way. Null for any other key.
 * @param {FocusRegion} region @param {string} keystroke
 * @returns {FocusRegion | null}
 */
export function nextRegion(region, keystroke) {
  const step = keystroke === "tab" ? 1 : keystroke === "shift-tab" ? -1 : 0;
  if (!step) return null;
  return REGIONS[(REGIONS.indexOf(region) + step + REGIONS.length) % REGIONS.length];
}

/**
 * What a key (in keys.json spelling, KeyEvent.keystroke) does in the Graph. Every
 * key but Up and Down needs a selected row (a commit or a file row).
 * @param {string} keystroke @param {GraphItem | null} selected
 * @returns {GraphKeyAction | null}
 */
export function graphKeyAction(keystroke, selected) {
  if (keystroke === "up" || keystroke === "down") return keystroke;
  if (!selected) return null;
  const onCommit = selected.kind === "commit";
  switch (keystroke) {
    case "right":
    case "space": return onCommit ? "expand" : null;
    case "left": return onCommit ? "collapse" : "parent";
    case "enter": return onCommit ? "toggle" : "open";
    default: return null;
  }
}
