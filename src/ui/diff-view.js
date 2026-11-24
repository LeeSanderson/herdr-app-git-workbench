// @ts-check
// The Diff view: one Herdr tab per Diff target (props().diff).
//
// Split mode is one v_virtual_list with a fixed row height; each row holds both
// sides, so the two sides scroll together. Every row is w_full().

import { div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { props, theme, settings } from "herdr";
import { statusLetter, statusColor, printable, folderOf, nameOf } from "./theme.js";
import { claimTab } from "./diff-tabs.js";
import { displaySegments } from "../core/display.js";

/** @typedef {import("../core/diff-target.js").DiffTarget} DiffTarget */
/** @typedef {import("../core/rows.js").SplitRow} SplitRow */
/** @typedef {import("../core/rows.js").Half} Half */

const TINT = "1c"; // ~11% alpha
const STRONG = "55"; // ~33% alpha, the changed part of a modified line

const fontSize = () => settings().font_size ?? 13;
const rowH = () => Math.ceil(fontSize() * 1.6);

const BADGES = {
  staged: ["Staged", "ansi2"],
  changes: ["Unstaged", "ansi3"],
  untracked: ["Untracked", "ansi2"],
  conflicts: ["Conflict", "ansi1"],
};

export class DiffView {
  /** @param {ReturnType<import("../core/workbench.js").createWorkbench>} workbench @param {import("gpui-kit").Context} cx */
  constructor(workbench, cx) {
    this.workbench = workbench;
    /** @type {DiffTarget | null} */
    this.target = /** @type {any} */ (props())?.diff ?? null;
    /** @type {import("../core/diff.js").DiffDocument | null} */
    this.doc = null;
    /** @type {string | null} */
    this.error = null;
    this.scroll = VirtualListScrollHandle.new();
    if (this.target) {
      claimTab(this.target);
      this.load(cx);
    }
  }

  /** @param {import("gpui-kit").Context} cx */
  load(cx) {
    const target = this.target;
    if (!target) return;
    cx.spawn(async (cx) => {
      try {
        this.doc = await this.workbench.loadDiff(target);
        this.error = null;
      } catch (err) {
        this.error = String(err?.message ?? err);
      }
      cx.notify();
    });
  }

  /** @param {import("gpui-kit").Context} _cx */
  render(_cx) {
    const t = theme();
    const root = v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12);
    if (!this.target) return root.child(div().p(16).text_color(t.dim).child("No Diff target"));
    return root
      .child(this.header(t, this.target))
      .when(!!this.doc?.notice, (e) => e.child(this.noticeBand(t, /** @type {string} */ (this.doc?.notice))))
      .child(v_flex().flex_1().min_h(0).font_family(settings().font_family ?? "monospace").text_size(fontSize()).child(this.body(t)));
  }

  /** @param {Record<string, string>} t @param {DiffTarget} target */
  header(t, target) {
    const color = statusColor(t, target);
    const [label, slot] = BADGES[target.group] ?? ["", "muted"];
    const path = printable(target.newPath);
    const bar = h_flex().flex_none().h(34).px(12).gap(8).items_center().border_b_1().border_color(t.border).bg(t.surface)
      .child(div().flex_none().w(18).h(18).rounded(4).bg(color + "33").flex().items_center().justify_center()
        .text_size(10).font_semibold().text_color(color).child(statusLetter(target)))
      .child(h_flex().min_w(0).flex_shrink(1)
        .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.dim).child(folderOf(path)))
        .child(div().flex_none().font_semibold().child(nameOf(path))));
    if (target.oldPath !== target.newPath) {
      const similarity = this.doc?.similarity != null ? ` (${this.doc.similarity}%)` : "";
      bar.child(div().flex_shrink(1).min_w(0).truncate().text_color(t.dim).child(`← ${printable(target.oldPath)}${similarity}`));
    }
    bar.child(div().flex_none().px(6).rounded(4).text_size(10).bg(t[slot] + "33").text_color(t[slot]).child(label));
    if (this.doc) {
      bar.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${this.doc.adds}`))
        .child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${this.doc.dels}`));
    }
    return bar;
  }

  /**
   * The thin notice band under the header (binary, new, deleted, untracked, mode change).
   * @param {Record<string, string>} t @param {string} text
   */
  noticeBand(t, text) {
    return div().flex_none().px(12).py(3).border_b_1().border_color(t.border).bg(t.raised)
      .text_size(11).text_color(t.muted).truncate().child(text);
  }

  /** @param {Record<string, string>} t */
  body(t) {
    if (this.error && !this.doc) return div().p(16).text_color(t.ansi1).child(this.error);
    if (!this.doc) return div().p(16).text_color(t.dim).child("Loading diff…");
    if (this.doc.binary) return div().p(16).text_color(t.dim).child("Binary file changed");
    const rows = this.doc.rows("split");
    if (!rows.length) return div().p(16).text_color(t.dim).child("No text changes");
    const h = rowH();
    const gutterW = Math.ceil(Math.max(4, String(rows.length).length) * fontSize() * 0.6) + 12;
    const list = v_virtual_list("diff-rows", rows.length, h, (i) => String(i),
      (range) => rows.slice(range.start, range.end).map((r) => this.splitRow(t, r, h, gutterW)))
      .track_scroll(this.scroll)
      .size_full();
    return div().flex_1().min_h(0).relative()
      .child(list)
      .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0());
  }

  /** @param {Record<string, string>} t @param {SplitRow} row @param {number} h @param {number} gutterW */
  splitRow(t, row, h, gutterW) {
    return h_flex().w_full().h(h).flex_none().items_center().overflow_hidden()
      .child(this.half(t, row, row.left, "del", gutterW))
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(this.half(t, row, row.right, "add", gutterW));
  }

  /**
   * One side of a row. `side` is what a change on this side is: "del" left, "add" right.
   * @param {Record<string, string>} t @param {SplitRow} row @param {Half | null} cell
   * @param {"del" | "add"} side @param {number} gutterW
   */
  half(t, row, cell, side, gutterW) {
    const el = h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden();
    if (!cell) return el.bg(t.canvas);
    const changed = row.kind !== "ctx";
    const base = side === "add" ? t.ansi2 : t.ansi1;
    const segs = displaySegments(cell.text, cell.changed);
    return el
      .when(changed, (e) => e.bg(base + TINT))
      .child(div().w(gutterW).flex_none().pr(8).text_right().text_color(changed ? t.muted : t.dim).child(String(cell.line)))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
        .children(segs.length
          ? segs.map((g, i) => (i === segs.length - 1 ? div().truncate() : div().flex_none()).when(g.hl, (e) => e.bg(base + STRONG).rounded(2)).child(g.s))
          : [div().child(" ")]))
      .when(!!cell.noeol, (e) => e.child(div().flex_none().px(4).text_color(t.ansi1).child("⊘ no newline")));
  }
}
