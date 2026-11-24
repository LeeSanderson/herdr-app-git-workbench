// @ts-check
// Small shared UI helpers: status letters and colours, path display.

import { div } from "gpui-kit";
import { v_flex, Scrollbar } from "gpui-base";

/** @typedef {import("../core/status.js").Change} Change */

/**
 * The letter a row shows. It is derived from the group, not stored in the core:
 * a Conflict shows `!` and an untracked file `U`; other Changes show their status.
 * @param {Change} change
 */
export function statusLetter(change) {
  if (change.group === "conflicts") return "!";
  if (change.group === "untracked") return "U";
  return change.status;
}

/**
 * A row letter's colour from the theme's ANSI slots: M/T yellow, A/U green, D/! red, R blue.
 * @param {Record<string, string>} t @param {Change} change
 */
export function statusColor(t, change) {
  const colors = { M: t.ansi3, T: t.ansi3, A: t.ansi2, U: t.ansi2, D: t.ansi1, "!": t.ansi1, R: t.ansi4 };
  return colors[statusLetter(change)] ?? t.muted;
}

/** Makes control characters in a path visible (a filename may hold a newline or tab). @param {string} s */
export const printable = (s) => s.replace(/[\x00-\x1f\x7f]/g, (c) => (c === "\n" ? "↵" : c === "\t" ? "⇥" : "�"));

/** The folder part of a Git path, with its trailing slash ("" at the top level). @param {string} p */
export const folderOf = (p) => p.slice(0, p.lastIndexOf("/") + 1);

/** The file-name part of a Git path. @param {string} p */
export const nameOf = (p) => p.slice(p.lastIndexOf("/") + 1);

/**
 * A vertical scrolling area that fills the space it is given.
 * @param {string} id @param {any[]} children
 */
export function scrollArea(id, children) {
  // The list is in flow (not absolute) so the area takes its content's height when
  // its parent has no fixed height (an overlay) and scrolls when it does (a docked column).
  return v_flex().flex_1().min_h(0).relative()
    .child(v_flex().id(id).flex_1().min_h(0).overflow_y_scroll().children(children))
    .child(Scrollbar.vertical(id).absolute().inset_0());
}
