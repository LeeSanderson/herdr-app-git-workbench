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
//
// Long lines pan, never wrap: one column offset (`pan`) shared by both halves,
// gutters fixed. ‹ marks hidden text on the left, … text cut off on the right.
// Panning: shift-wheel / horizontal swipe, ←/→ (8 columns), Home, the thin bar
// under the rows, and jumping to a change (pans to its first changed column).
// The visible column count comes from the body's width, measured from mouse-event
// bounds and estimated from the window until the first event.

import { div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { props, theme, settings, shared, setShared } from "herdr";
import { statusLetter, statusColor, printable, folderOf, nameOf } from "./theme.js";
import { claimTab } from "./diff-tabs.js";
import { changeAnchors } from "../core/rows.js";
import { LINE_LIMIT } from "../core/diff.js";

/** @typedef {import("../core/diff-target.js").DiffTarget} DiffTarget */
/** @typedef {import("../core/rows.js").SplitRow} SplitRow */
/** @typedef {import("../core/rows.js").InlineRow} InlineRow */
/** @typedef {import("../core/rows.js").GapRow} GapRow */
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

const PAN_STEP = 8; // columns per ←/→

const fontSize = () => settings().font_size ?? 13;
const rowH = () => Math.ceil(fontSize() * 1.6);
/** The width of one monospace column, estimated. */
const charW = () => fontSize() * 0.6;

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

/** 12345 → "12,345" (no Intl in every runtime). @param {number} n */
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A raw line's width in display columns (tabs expanded). @param {string} text */
const displayCols = (text) => segments(text, undefined).reduce((n, g) => n + g.s.length, 0);

/**
 * The display segments of columns [from, from + n), and whether non-blank text is
 * hidden on the left or any text cut off on the right.
 * @param {{ s: string, hl: boolean }[]} segs @param {number} from @param {number} n
 */
function columns(segs, from, n) {
  const out = [];
  let col = 0;
  let hidden = "";
  for (const g of segs) {
    const start = col;
    col += g.s.length;
    if (start < from) hidden += g.s.slice(0, Math.min(from, col) - start);
    const a = Math.max(start, from);
    const b = Math.min(col, from + n);
    if (b > a) out.push({ s: g.s.slice(a - start, b - start), hl: g.hl });
  }
  return { segs: out, left: hidden.trim() !== "", right: col > from + n };
}

/** @type {WeakMap<readonly object[], number>} */
const longestCache = new WeakMap();
/** The widest row's text in display columns. @param {readonly any[]} rows */
function longest(rows) {
  let n = longestCache.get(rows);
  if (n === undefined) {
    n = 0;
    for (const r of rows) {
      if (r.kind === "gap") continue;
      n = Math.max(n, r.left !== undefined ? Math.max(r.left ? displayCols(r.left.text) : 0, r.right ? displayCols(r.right.text) : 0) : displayCols(r.text));
    }
    longestCache.set(rows, n);
  }
  return n;
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
    /** The column offset shared by every row's text. */
    this.pan = 0;
    /** The rows area's width in px, from the last mouse event over it; null until then. */
    this.bodyW = null;
    /** The pan bar's track bounds while its thumb is dragged. @type {{ x: number, width: number } | null} */
    this.drag = null;
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
    this.panToChange(diffMode());
  }

  // --- panning ---

  /** The width of the line-number gutter. */
  gutterW() {
    const n = Math.max(this.doc?.lines ?? 0, this.doc?.rows("split").length ?? 0);
    return Math.ceil(Math.max(4, String(n).length) * charW()) + 12;
  }

  /** The rows area's width: measured from mouse events, estimated from the window until then. */
  bodyWidth() {
    return this.bodyW ?? (globalThis.window?.viewport_size?.().width ?? 1400) - 300;
  }

  /** Text columns visible per half (split) or in the one text column (inline). @param {RowMode} mode */
  textCols(mode) {
    const usable = this.bodyWidth() - 12 - 3; // vertical scrollbar, marker
    const px = mode === "inline" ? usable - 2 * this.gutterW() - 14 : (usable - 1) / 2 - this.gutterW();
    return Math.max(10, Math.floor(px / charW()) - 2); // the ‹ column, a little slack
  }

  /** @param {RowMode} mode */
  maxPan(mode) {
    return this.doc ? Math.max(0, longest(this.doc.rows(mode)) - this.textCols(mode) + 2) : 0;
  }

  /** @param {number} v @param {RowMode} mode */
  setPan(v, mode) {
    this.pan = Math.round(Math.max(0, Math.min(this.maxPan(mode), v)));
  }

  /**
   * Pans so the first changed column of the current change is in view: back to
   * column 0 when it fits there. Unpaired lines count from their first non-blank column.
   * @param {RowMode} mode
   */
  panToChange(mode) {
    if (!this.doc) return;
    /** @param {string} text @param {[number, number] | undefined} changed */
    const first = (text, changed) => displayCols(text.slice(0, changed ? changed[0] : text.length - text.trimStart().length));
    let col = Infinity;
    for (const r of /** @type {readonly any[]} */ (this.doc.rows(mode))) {
      if (r.block !== this.current) continue;
      if (r.left !== undefined) {
        for (const h of [r.left, r.right]) if (h) col = Math.min(col, first(h.text, h.changed));
      } else col = Math.min(col, first(r.text, r.changed));
    }
    if (col === Infinity) return;
    const cols = this.textCols(mode);
    if (col >= this.pan && col < this.pan + cols - 8) return;
    this.setPan(col < cols - 8 ? 0 : col - 8, mode);
  }

  /** Shift-wheel or a horizontal swipe pans. @param {import("gpui-kit").ScrollWheelEvent} e @param {import("gpui-kit").Context} cx */
  onWheel(e, cx) {
    if (e.bounds) this.bodyW = e.bounds.width;
    let dx = e.delta.x;
    if (!dx && e.modifiers.shift) dx = e.delta.y;
    if (!dx || (!e.modifiers.shift && Math.abs(dx) < Math.abs(e.delta.y))) return;
    this.setPan(this.pan - dx / charW(), diffMode());
    cx.stop_propagation();
    cx.notify();
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
    else if (k === "left" || k === "right") this.setPan(this.pan + (k === "right" ? PAN_STEP : -PAN_STEP), diffMode());
    else if (k === "home") this.setPan(0, diffMode());
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  /** @param {import("gpui-kit").Context} _cx */
  render(_cx) {
    const t = theme();
    const root = v_flex().id("diff").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12)
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => this.onKey(e, cx))
      // Dragging the pan bar's thumb: follow the pointer anywhere over the view.
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        if (e.pressed_button !== "left") { this.drag = null; return; }
        this.panTo(e.position.x, this.drag, diffMode());
        cx.notify();
      })
      .on_mouse_up("left", () => { this.drag = null; });
    if (!this.target) return root.child(div().p(16).text_color(t.dim).child("No Diff target"));
    const mode = diffMode();
    return root
      .child(this.header(t, this.target, mode))
      .when(!!this.doc?.truncated, (e) => e.child(this.notice(t, `This file has ${thousands(this.doc.lines)} lines, over the ${thousands(LINE_LIMIT)}-line limit, so only the changed sections are shown.`)))
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
    const gutterW = this.gutterW();
    // Read once per render: every row's text shows the same columns.
    this.setPan(this.pan, mode);
    this.cols = this.textCols(mode);
    const render = (/** @type {any} */ r) => r.kind === "gap" ? this.gapRow(t, r, h)
      : mode === "inline" ? this.inlineRow(t, r, h, gutterW)
      : this.splitRow(t, r, h, gutterW);
    const list = v_virtual_list("diff-rows", rows.length, h, (i) => String(i),
      (range) => rows.slice(range.start, range.end).map(render))
      .track_scroll(this.scroll)
      .size_full();
    return v_flex().flex_1().min_h(0)
      .child(div().flex_1().min_h(0).relative()
        .on_mouse_move((e, cx) => {
          if (e.bounds && Math.abs(e.bounds.width - (this.bodyW ?? 0)) > 1) { this.bodyW = e.bounds.width; cx.notify(); }
        })
        .on_scroll_wheel((e, cx) => this.onWheel(e, cx))
        .child(list)
        .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0()))
      .when(this.maxPan(mode) > 0, (e) => e.child(this.panBar(t, mode)));
  }

  /**
   * The thin horizontal bar under the rows: the thumb is the visible share of
   * the longest line. Click or drag the track to pan.
   * @param {Record<string, string>} t @param {RowMode} mode
   */
  panBar(t, mode) {
    const cols = this.textCols(mode);
    const total = cols + this.maxPan(mode);
    const share = Math.max(0.05, cols / total);
    const at = Math.min(1 - share, this.pan / total);
    return h_flex().id("pan-bar").flex_none().h(10).px(4).items_center().bg(t.surface).border_t_1().border_color(t.border)
      .child(div().id("pan-track").flex_1().h(6).relative().rounded(3).bg(t.raised).cursor_pointer()
        .on_mouse_down("left", (e, cx) => {
          if (!e.bounds) return;
          cx.stop_propagation();
          this.handle.focus();
          this.drag = e.bounds;
          this.panTo(e.position.x, e.bounds, mode);
          cx.notify();
        })
        .child(div().absolute().top(0).h(6).rounded(3).bg(t.muted).left(`${(at * 100).toFixed(2)}%`).w(`${(share * 100).toFixed(2)}%`)));
  }

  /** Pans so the pointer at window x is the middle of the thumb. @param {number} x @param {{ x: number, width: number }} track @param {RowMode} mode */
  panTo(x, track, mode) {
    const cols = this.textCols(mode);
    this.setPan(((x - track.x) / track.width) * (cols + this.maxPan(mode)) - cols / 2, mode);
  }

  /** A notice band under the header. @param {Record<string, string>} t @param {string} message */
  notice(t, message) {
    return div().flex_none().px(12).py(3).bg(t.raised).border_b_1().border_color(t.border).text_size(11).text_color(t.muted).child(message);
  }

  /** `⋯ N unchanged lines` and the next hunk's function title. @param {Record<string, string>} t @param {GapRow} row @param {number} h */
  gapRow(t, row, h) {
    return h_flex().w_full().h(h).flex_none().items_center().gap(8).overflow_hidden().bg(t.raised).text_color(t.dim).text_size(11)
      .child(this.marker(t, undefined))
      .child(div().flex_none().pl(8).child(`⋯ ${thousands(row.count)} unchanged line${row.count === 1 ? "" : "s"}`))
      .when(!!row.title, (e) => e.child(div().min_w(0).truncate().text_color(t.muted).child(row.title)));
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
      .child(this.text(t, cell.text, cell.changed, base))
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
      .child(this.text(t, row.text, row.changed, base))
      .when(!!row.noeol, (e) => e.child(this.noEol(t)));
  }

  /**
   * A line's text from the pan column on, with its changed part (if any) in the
   * stronger tint of `base`. When panned, a one-column ‹ cell (blank if only
   * spaces are hidden) keeps columns aligned; … ends a line cut off on the right.
   * @param {Record<string, string>} t @param {string} text @param {[number, number] | undefined} changed @param {string} base
   */
  text(t, text, changed, base) {
    const all = segments(text, changed);
    const cols = this.cols ?? 80;
    let win = columns(all, this.pan, cols);
    if (win.right) win = { ...columns(all, this.pan, cols - 1), right: true };
    const segs = win.segs;
    return h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
      .when(this.pan > 0, (e) => e.child(div().w(charW()).flex_none().text_color(t.accent).child(win.left ? "‹" : "")))
      .children(segs.length
        ? segs.map((g, i) => (i === segs.length - 1 ? div().truncate() : div().flex_none()).when(g.hl, (e) => e.bg(base + STRONG).rounded(2)).child(g.s))
        : [div().child(" ")])
      .when(win.right, (e) => e.child(div().flex_none().text_color(t.dim).child("…")));
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
