// @ts-check
// The Diff view: one Herdr tab per Diff target (props().diff).
//
// Both modes are one v_virtual_list with a fixed row height. A split row holds
// both sides, so the two sides scroll together; an inline row is one line with
// old and new line-number gutters and a +/− sign. Every row is w_full().
//
// The mode (split | inline) is one shared setting for every Diff view. Keys are
// handled with on_key_down on the view's focus handle (not keys.json):
// i toggles the mode; n / f7 and p / shift-f7 jump to the next / previous change.
// alt-up / alt-down are Herdr's agent.prev / agent.next, so they are not used.

import { div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { props, theme, settings, shared, setShared } from "herdr";
import { statusLetter, statusColor, printable, folderOf, nameOf } from "./theme.js";
import { claimTab } from "./diff-tabs.js";
import { changeAnchors } from "../core/rows.js";

/** @typedef {import("../core/diff-target.js").DiffTarget} DiffTarget */
/** @typedef {import("../core/rows.js").SplitRow} SplitRow */
/** @typedef {import("../core/rows.js").InlineRow} InlineRow */
/** @typedef {import("../core/rows.js").Half} Half */
/** @typedef {import("../core/rows.js").RowMode} RowMode */

/** The shared key of the Diff view mode; every Diff view re-renders when it changes. */
const MODE_KEY = "gitwb.diffMode";
/** @returns {RowMode} */
const diffMode = () => (shared(MODE_KEY) === "inline" ? "inline" : "split");
/** @param {RowMode} mode */
const setDiffMode = (mode) => setShared(MODE_KEY, mode);

const NEXT_KEYS = new Set(["n", "f7"]);
const PREV_KEYS = new Set(["p", "shift-f7"]);

const TAB = 4;
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

/**
 * Splits a raw line into display segments: tabs expanded to 4-column stops, a
 * CR shown as ␍, and the `changed` range marked.
 * @param {string} text @param {[number, number] | undefined} changed
 * @returns {{ s: string, hl: boolean }[]}
 */
function segments(text, changed) {
  const cuts = changed ? [[0, changed[0], false], [changed[0], changed[1], true], [changed[1], text.length, false]] : [[0, text.length, false]];
  let col = 0;
  const out = [];
  for (const [from, to, hl] of /** @type {[number, number, boolean][]} */ (cuts)) {
    let s = "";
    for (let i = from; i < to; i++) {
      const c = text[i];
      if (c === "\t") {
        const n = TAB - (col % TAB);
        s += " ".repeat(n);
        col += n;
      } else {
        s += c === "\r" ? "␍" : c;
        col++;
      }
    }
    if (s) out.push({ s, hl });
  }
  return out;
}

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
    this.handle = cx.focus_handle();
    /** The change block the navigator is on; -1 before the first jump. */
    this.current = -1;
    // A new Diff tab takes the keyboard so n/p/i work straight away (unverified in the app).
    this.handle.focus();
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

  /** The navigation anchors (first row of each change block) for `mode`. @param {RowMode} mode */
  anchors(mode) {
    return this.doc ? changeAnchors(this.doc.rows(mode)) : [];
  }

  /**
   * Jumps `delta` changes from the current one, wrapping from last to first,
   * and centres it. Before the first jump, next goes to the first change and
   * previous to the last.
   * @param {1 | -1} delta
   */
  go(delta) {
    const anchors = this.anchors(diffMode());
    const n = anchors.length;
    if (!n) return;
    this.current = this.current < 0 || this.current >= n
      ? (delta > 0 ? 0 : n - 1)
      : (this.current + delta + n) % n;
    this.scroll.scroll_to_item(anchors[this.current], "center");
  }

  /** @param {RowMode} mode */
  setMode(mode) {
    if (mode === diffMode()) return;
    setDiffMode(mode);
    // Keep the current change in view: its block keeps its number in both modes.
    const anchor = this.anchors(mode)[this.current];
    if (anchor !== undefined) this.scroll.scroll_to_item(anchor, "center");
  }

  /** @param {import("gpui-kit").KeyEvent} e @param {import("gpui-kit").Context} cx */
  onKey(e, cx) {
    const k = e.keystroke;
    if (NEXT_KEYS.has(k)) this.go(1);
    else if (PREV_KEYS.has(k)) this.go(-1);
    else if (k === "i") this.setMode(diffMode() === "inline" ? "split" : "inline");
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  /** @param {import("gpui-kit").Context} _cx */
  render(_cx) {
    const t = theme();
    const root = v_flex().id("diff").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12)
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => this.onKey(e, cx));
    if (!this.target) return root.child(div().p(16).text_color(t.dim).child("No Diff target"));
    const mode = diffMode();
    return root
      .child(this.header(t, this.target, mode))
      .child(v_flex().flex_1().min_h(0).font_family(settings().font_family ?? "monospace").text_size(fontSize()).child(this.body(t, mode)));
  }

  /** @param {Record<string, string>} t @param {DiffTarget} target @param {RowMode} mode */
  header(t, target, mode) {
    const color = statusColor(t, target);
    const [label, slot] = BADGES[target.group] ?? ["", "muted"];
    const path = printable(target.newPath);
    const bar = h_flex().flex_none().h(34).px(12).gap(8).items_center().border_b_1().border_color(t.border).bg(t.surface)
      .child(div().flex_none().w(18).h(18).rounded(4).bg(color + "33").flex().items_center().justify_center()
        .text_size(10).font_semibold().text_color(color).child(statusLetter(target)))
      .child(h_flex().min_w(0).flex_shrink(1)
        .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.dim).child(folderOf(path)))
        .child(div().flex_none().font_semibold().child(nameOf(path))))
      .child(div().flex_none().px(6).rounded(4).text_size(10).bg(t[slot] + "33").text_color(t[slot]).child(label));
    if (this.doc) {
      bar.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${this.doc.adds}`))
        .child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${this.doc.dels}`));
    }
    bar.child(div().flex_1());
    if (this.doc) bar.child(this.navigator(t, mode));
    return bar.child(this.modeSwitch(t, mode));
  }

  /** "Change k of N" with ↑/↓ buttons. @param {Record<string, string>} t @param {RowMode} mode */
  navigator(t, mode) {
    const n = this.anchors(mode).length;
    const k = this.current >= 0 && this.current < n ? String(this.current + 1) : "–";
    /** @param {string} id @param {string} label @param {1 | -1} delta */
    const arrow = (id, label, delta) => div().id(id).flex_none().w(20).h(20).rounded(4).flex().items_center().justify_center()
      .text_color(n ? t.muted : t.dim)
      .when(n > 0, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => { cx.stop_propagation(); this.go(delta); cx.notify(); })
      .child(label);
    return h_flex().flex_none().gap(2).items_center().text_size(11)
      .child(div().flex_none().pr(4).text_color(t.muted).child(n ? `Change ${k} of ${n}` : "No changes"))
      .child(arrow("change-prev", "↑", -1))
      .child(arrow("change-next", "↓", 1));
  }

  /** The "Side by side | Inline" segmented switch. @param {Record<string, string>} t @param {RowMode} mode */
  modeSwitch(t, mode) {
    /** @param {RowMode} value @param {string} label */
    const seg = (value, label) => div().id(`mode-${value}`).px(8).h(20).flex().items_center().rounded(4).text_size(11).cursor_pointer()
      .when(mode === value, (e) => e.bg(t.background).text_color(t.foreground).font_semibold())
      .when(mode !== value, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => { cx.stop_propagation(); this.setMode(value); cx.notify(); })
      .child(label);
    return h_flex().flex_none().p(2).gap(2).rounded(6).bg(t.raised)
      .child(seg("split", "Side by side"))
      .child(seg("inline", "Inline"));
  }

  /** @param {Record<string, string>} t @param {RowMode} mode */
  body(t, mode) {
    if (this.error && !this.doc) return div().p(16).text_color(t.ansi1).child(this.error);
    if (!this.doc) return div().p(16).text_color(t.dim).child("Loading diff…");
    const rows = this.doc.rows(mode);
    if (!rows.length) return div().p(16).text_color(t.dim).child("No text changes");
    const h = rowH();
    const gutterW = Math.ceil(Math.max(4, String(rows.length).length) * fontSize() * 0.6) + 12;
    const render = mode === "inline"
      ? (/** @type {any} */ r) => this.inlineRow(t, r, h, gutterW)
      : (/** @type {any} */ r) => this.splitRow(t, r, h, gutterW);
    const list = v_virtual_list("diff-rows", rows.length, h, (i) => String(i),
      (range) => rows.slice(range.start, range.end).map(render))
      .track_scroll(this.scroll)
      .size_full();
    return div().flex_1().min_h(0).relative()
      .child(list)
      .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0());
  }

  /** @param {Record<string, string>} t @param {SplitRow} row @param {number} h @param {number} gutterW */
  splitRow(t, row, h, gutterW) {
    return h_flex().w_full().h(h).flex_none().items_center().overflow_hidden()
      .child(this.marker(t, row.block))
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
    return el
      .when(changed, (e) => e.bg(base + TINT))
      .child(div().w(gutterW).flex_none().pr(8).text_right().text_color(changed ? t.muted : t.dim).child(String(cell.line)))
      .child(this.text(cell.text, cell.changed, base))
      .when(!!cell.noeol, (e) => e.child(this.noEol(t)));
  }

  /**
   * One inline row: old and new line-number gutters, a +/− sign, then the text.
   * @param {Record<string, string>} t @param {InlineRow} row @param {number} h @param {number} gutterW
   */
  inlineRow(t, row, h, gutterW) {
    const changed = row.kind !== "ctx";
    const base = row.kind === "add" ? t.ansi2 : t.ansi1;
    /** @param {number | undefined} n */
    const gutter = (n) => div().w(gutterW).flex_none().pr(8).text_right().text_color(changed ? t.muted : t.dim).child(n === undefined ? "" : String(n));
    return h_flex().w_full().h(h).flex_none().items_center().overflow_hidden()
      .when(changed, (e) => e.bg(base + TINT))
      .child(this.marker(t, row.block))
      .child(gutter(row.a))
      .child(gutter(row.b))
      .child(div().w(14).flex_none().text_color(changed ? base : t.dim).child(row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""))
      .child(this.text(row.text, row.changed, base))
      .when(!!row.noeol, (e) => e.child(this.noEol(t)));
  }

  /**
   * A line's text, with its changed part (if any) in the stronger tint of `base`.
   * @param {string} text @param {[number, number] | undefined} changed @param {string} base
   */
  text(text, changed, base) {
    const segs = segments(text, changed);
    return h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
      .children(segs.length
        ? segs.map((g, i) => (i === segs.length - 1 ? div().truncate() : div().flex_none()).when(g.hl, (e) => e.bg(base + STRONG).rounded(2)).child(g.s))
        : [div().child(" ")]);
  }

  /** @param {Record<string, string>} t */
  noEol(t) {
    return div().flex_none().px(4).text_color(t.ansi1).child("⊘ no newline");
  }

  /**
   * The 3 px bar at the start of every row; `accent` on the rows of the current change.
   * @param {Record<string, string>} t @param {number | undefined} block
   */
  marker(t, block) {
    return div().w(3).h_full().flex_none().when(block !== undefined && block === this.current, (e) => e.bg(t.accent));
  }
}
