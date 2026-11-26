// @ts-check
// The Source Control panel's list keys: which row is selected, and what a key does to it.
// Herdr-free so it can be tested; the panel maps the actions onto its own calls.

import { isDiscardable, unstagedChanges } from "./status.js";

/** @typedef {import("./status.js").Change} Change */
/** @typedef {{ key: string, change: Change }} ListRow */
/** The selected row: its key, and its index when last seen (kept for when the row leaves). */
/** @typedef {{ key: string, index: number }} Selection */
/** @typedef {"up" | "down" | "toggle" | "open" | "discard" | "commit-box"} ListKeyAction */

/** A row's key: unique across both lists (one path can be staged and unstaged). @param {Change} change */
export const rowKey = (change) => `${change.group}:${change.path}`;

/**
 * Every row in the order the panel shows them: the Unstaged list (Conflicts, Changes,
 * Untracked) and then the Staged list.
 * @param {import("./status.js").ChangeGroups} groups
 * @returns {ListRow[]}
 */
export function listRows(groups) {
  return [...unstagedChanges(groups), ...groups.staged]
    .map((change) => ({ key: rowKey(change), change }));
}

/**
 * What a key (in keys.json spelling, KeyEvent.keystroke) does in the list. Space, Enter
 * and Delete need a selected row; Delete only discards Changes and Untracked rows.
 * @param {string} keystroke @param {Change | null} selected
 * @returns {ListKeyAction | null}
 */
export function listKeyAction(keystroke, selected) {
  switch (keystroke) {
    case "up": return "up";
    case "down": return "down";
    case "tab": return "commit-box";
    case "space": return selected ? "toggle" : null;
    case "enter": return selected ? "open" : null;
    case "delete":
      return selected && isDiscardable(selected) ? "discard" : null;
    default: return null;
  }
}

/**
 * Moves the selection by `delta` rows, stopping at either end. With nothing selected,
 * Down picks the first row and Up the last.
 * @param {ListRow[]} rows @param {Selection | null} selection @param {1 | -1} delta
 * @returns {Selection | null}
 */
export function moveSelection(rows, selection, delta) {
  if (!rows.length) return null;
  const current = settleSelection(rows, selection);
  const index = current ? Math.min(rows.length - 1, Math.max(0, current.index + delta)) : delta > 0 ? 0 : rows.length - 1;
  return { key: rows[index].key, index };
}

/**
 * The selection after the rows changed: the same row if it is still listed, else the
 * row now at its old place (or the last row), so Space can walk down a list.
 * @param {ListRow[]} rows @param {Selection | null} selection
 * @returns {Selection | null}
 */
export function settleSelection(rows, selection) {
  if (!selection || !rows.length) return null;
  const found = rows.findIndex((r) => r.key === selection.key);
  const index = found >= 0 ? found : Math.min(selection.index, rows.length - 1);
  return { key: rows[index].key, index };
}
