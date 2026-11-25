// @ts-check
// Small UI pieces shared by the panel and the Diff view: status letters and
// colours, printable paths, the scroll area, tinted bands and icon buttons.

import { div } from "gpui-kit";
import { v_flex, Scrollbar } from "gpui-base";

/** @typedef {import("../core/status.js").Change} Change */

/**
 * The letter a row shows. It is derived from the group, not stored in the core:
 * a Conflict shows `!` and an untracked file `U`; other Changes show their status.
 * @param {Pick<Change, "group" | "status">} change
 */
export function statusLetter(change) {
  if (change.group === "conflicts") return "!";
  if (change.group === "untracked") return "U";
  return change.status;
}

/**
 * A row letter's colour from the theme's ANSI slots: M/T yellow, A/U green, D/! red, R blue.
 * @param {Record<string, string>} t @param {Pick<Change, "group" | "status">} change
 */
export function statusColor(t, change) {
  const colors = { M: t.ansi3, T: t.ansi3, A: t.ansi2, U: t.ansi2, D: t.ansi1, "!": t.ansi1, R: t.ansi4 };
  return colors[statusLetter(change)] ?? t.muted;
}

/** Makes control characters in a path visible (a filename may hold a newline or tab). @param {string} s */
export const printable = (s) => s.replace(/[\x00-\x1f\x7f]/g, (c) => (c === "\n" ? "↵" : c === "\t" ? "⇥" : "�"));

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

/**
 * A full-width band tinted with one ANSI colour (warnings, errors, conflicts).
 * Callers add padding, size and children.
 * @param {Record<string, string>} t @param {string} color a theme colour, e.g. t.ansi1
 */
export function band(t, color) {
  return div().flex_none().text_size(11).bg(color + "22").text_color(color).border_b_1().border_color(t.border);
}

/**
 * A 22 px square glyph button (⟳, ✕) for a header.
 * @param {Record<string, string>} t @param {string} id @param {string} glyph @param {() => void} onClick
 */
export function iconButton(t, id, glyph, onClick) {
  return div().id(id).flex_none().w(22).h(22).flex().items_center().justify_center().rounded(4)
    .text_size(13).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => {
      cx.stop_propagation();
      onClick();
      cx.notify();
    })
    .child(glyph);
}
