// @ts-check
// The Graph section of the Source Control panel: a collapsible header and a
// virtual list of two-line commit rows, each with a lane-graph cell. It sits
// below the Change groups behind a draggable divider.

import { div, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, v_resizable, resizable_panel, Scrollbar } from "gpui-base";
import { rowWidth } from "../core/lanes.js";

/** @typedef {import("../core/graph.js").Graph} Graph */
/** @typedef {import("../core/graph.js").GraphState} GraphState */
/** @typedef {import("../core/history.js").Commit} Commit */
/** @typedef {import("../core/lanes.js").LaneRow} LaneRow */

/** The divider's id: the window keeps the dragged sizes under it. */
const SPLIT_ID = "scm-graph-split";
const LIST_ID = "graph-rows";
const HEADER_H = 28;
const COMMIT_H = 40;
const LANE_W = 12;
const STROKE = 2;

/**
 * Lane colours by lane index: the theme's bright blue, magenta, yellow, cyan, green, red.
 * @param {Record<string, string>} t
 */
const palette = (t) => [t.ansi12, t.ansi13, t.ansi11, t.ansi14, t.ansi10, t.ansi9];
/** @param {Record<string, string>} t @param {number} lane */
const laneColor = (t, lane) => { const p = palette(t); return p[lane % p.length]; };
/** @param {number} lane */
const laneX = (lane) => LANE_W / 2 + lane * LANE_W + 2;

/** "3 min ago", "5 h ago", "2 days ago"… from an ISO date. @param {string} iso @param {number} now */
export function relativeTime(iso, now) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (Number.isNaN(s)) return "";
  if (s < 60) return "just now";
  const units = [[60, "min"], [3600, "h"], [86400, "day"], [604800, "week"], [2629800, "month"], [31557600, "year"]];
  let [size, name] = units[0];
  for (const u of units) if (s >= u[0]) [size, name] = u;
  const n = Math.floor(s / /** @type {number} */ (size));
  const plural = name !== "min" && name !== "h" && n !== 1 ? "s" : "";
  return `${n} ${name}${plural} ago`;
}

export class GraphSection {
  constructor() {
    this.collapsed = false;
  }

  /**
   * The Change groups and commit box (`top`) above the Graph, split by a draggable
   * divider. The Graph starts at up to ⅔ of the viewport. Collapsed, the Graph is only
   * its header and there is no split. Starts the first load.
   * @param {Record<string, string>} t @param {Graph} graph @param {any} top
   */
  layout(t, graph, top) {
    if (graph.state.kind === "idle") void graph.load();
    const section = this.section(t, graph);
    if (this.collapsed) return v_flex().flex_1().min_h(0).child(top).child(section);
    const viewport = /** @type {any} */ (globalThis).window?.viewport_size?.();
    const height = viewport?.height ?? 900;
    const topPx = Math.max(160, Math.round(height / 3));
    return v_resizable(SPLIT_ID).flex_1().min_h(0)
      .child(resizable_panel().size(topPx).size_range(140).child(v_flex().size_full().child(top)))
      .child(resizable_panel().size_range(HEADER_H + 60).child(section));
  }

  /** @param {Record<string, string>} t @param {Graph} graph */
  section(t, graph) {
    const section = v_flex().id("graph").border_t_1().border_color(t.border).child(this.header(t, graph));
    if (this.collapsed) return section.flex_none();
    return section.size_full().min_h(0).child(body(t, graph));
  }

  /** @param {Record<string, string>} t @param {Graph} graph */
  header(t, graph) {
    return h_flex().id("graph-header").flex_none().h(HEADER_H).px(6).gap(6).items_center()
      .bg(t.chrome).border_b_1().border_color(t.border).cursor_pointer()
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.collapsed = !this.collapsed;
        cx.notify();
      })
      .child(div().flex_none().w(14).text_color(t.muted).child(this.collapsed ? "▸" : "▾"))
      .child(div().flex_1().text_size(12).font_semibold().child("Graph"))
      .child(filterSwitch(t, graph));
  }
}

/** @type {[import("../core/graph.js").RefFilter, string][]} */
const FILTER_LABELS = [["auto", "Auto"], ["all", "All"], ["current", "Current"]];

/**
 * The Auto | All | Current segments. Choosing one remembers it for the Repository and reloads.
 * @param {Record<string, string>} t @param {Graph} graph
 */
function filterSwitch(t, graph) {
  const group = h_flex().flex_none().h(20).rounded(4).border_1().border_color(t.border).overflow_hidden().text_size(11);
  for (const [mode, label] of FILTER_LABELS) {
    const on = graph.filter === mode;
    group.child(h_flex().id(`graph-filter-${mode}`).h_full().px(8).items_center()
      .when(on, (e) => e.bg(t.raised).font_semibold())
      .when(!on, (e) => e.text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (!on) void graph.setFilter(mode);
        cx.notify();
      })
      .child(label));
  }
  return group;
}

/** @param {Record<string, string>} t @param {Graph} graph */
function body(t, graph) {
  const state = graph.state;
  switch (state.kind) {
    case "idle":
    case "loading":
      return note(t, h_flex().gap(6)
        .child(div().text_color(t.muted).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 80))
        .child("Loading history…"));
    case "empty":
      return note(t, "No commits yet");
    case "error":
      return v_flex().id("graph-error").p(10).gap(6).text_size(12)
        .child(div().text_color(t.ansi1).child(state.error.summary))
        .child(h_flex().child(h_flex().id("graph-retry").flex_none().h(20).px(8).items_center().rounded(4).text_size(11)
          .bg(t.raised).cursor_pointer().hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            void graph.load();
            cx.notify();
          })
          .child("Retry")));
    case "ready":
      return list(t, state);
  }
}

/** @param {Record<string, string>} t @param {any} content */
function note(t, content) {
  return div().p(10).text_size(12).text_color(t.dim).child(content);
}

/**
 * The commit rows in a virtual list. Rows hold no handlers or state.
 * @param {Record<string, string>} t @param {Extract<GraphState, { kind: "ready" }>} state
 */
function list(t, state) {
  const { commits, rows, head } = state;
  const now = Date.now();
  const vl = v_virtual_list(LIST_ID, commits.length, COMMIT_H, (i) => `c:${commits[i].oid}`,
    (range) => {
      const out = [];
      for (let i = range.start; i < range.end; i++) out.push(commitRow(t, commits[i], rows[i], commits[i].oid === head, now));
      return out;
    })
    .size_full();
  return div().flex_1().min_h(0).relative()
    .child(vl)
    .child(Scrollbar.vertical(LIST_ID).absolute().inset_0());
}

/**
 * One commit: the graph cell, then the subject (bold for HEAD) over the short oid,
 * author, relative date and a `merge` marker.
 * @param {Record<string, string>} t @param {Commit} c @param {LaneRow} row @param {boolean} isHead @param {number} now
 */
function commitRow(t, c, row, isHead, now) {
  const merge = c.parents.length > 1;
  return h_flex().w_full().h(COMMIT_H).flex_none().items_center().gap(6).pr(8).overflow_hidden()
    .child(graphCell(t, row, COMMIT_H, isHead, merge))
    .child(v_flex().flex_1().min_w(0).gap(1)
      .child(h_flex().min_w(0).gap(4).items_center()
        .children(badges(t, c.badges, laneColor(t, row.lane)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).when(isHead, (e) => e.font_semibold()).child(c.subject || " ")))
      .child(h_flex().gap(6).text_size(11).text_color(t.dim)
        .child(div().flex_none().child(c.oid.slice(0, 7)))
        .child(div().flex_shrink(1).min_w(0).truncate().child(c.authorName))
        .child(div().flex_none().child(relativeTime(c.authorDate, now)))
        .when(merge, (e) => e.child(div().flex_none().text_color(t.muted).child("merge")))));
}

const MAX_BADGES = 3;
const GLYPHS = { head: "◉", local: "⎇", remote: "☁", tag: "◆" };

/**
 * The Ref badges of a commit: at most 3, then a `+N` pill. None, no elements (so no gap).
 * HEAD is outlined and bold, a local branch takes its lane's colour, a remote
 * branch is muted and a tag is ansi yellow.
 * @param {Record<string, string>} t @param {readonly import("../core/history.js").RefBadge[]} list @param {string} laneTint
 */
function badges(t, list, laneTint) {
  const out = list.slice(0, MAX_BADGES).map((b) => {
    const tint = b.kind === "head" ? t.foreground : b.kind === "local" ? laneTint : b.kind === "tag" ? t.ansi3 : t.muted;
    return pill(t, tint, `${GLYPHS[b.kind]} ${b.name}`)
      .when(b.kind === "head", (e) => e.border_color(tint).font_semibold());
  });
  if (list.length > MAX_BADGES) out.push(pill(t, t.muted, `+${list.length - MAX_BADGES}`));
  return out;
}

/** @param {Record<string, string>} t @param {string} tint @param {string} text */
function pill(t, tint, text) {
  return div().flex_none().max_w(140).truncate().h(16).px(5).rounded(8).text_size(10)
    .border_1().border_color(t.border).bg(t.raised).text_color(tint).child(text);
}

/**
 * The lane drawing for one row: one vector path per lane colour, then the dot.
 * Lanes waiting for this commit curve into its lane at the middle; its parents
 * leave from the dot to their lanes at the bottom; other lanes pass straight through.
 * @param {Record<string, string>} t @param {LaneRow} row @param {number} h @param {boolean} isHead @param {boolean} merge
 */
function graphCell(t, row, h, isHead, merge) {
  const colors = palette(t);
  /** @type {Map<number, any>} colour index → path builder */
  const builders = new Map();
  /** @param {number} lane */
  const pen = (lane) => {
    const k = lane % colors.length;
    if (!builders.has(k)) builders.set(k, PathBuilder.stroke(STROKE));
    return builders.get(k);
  };
  /** @param {number} lane colour @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 */
  const line = (lane, x1, y1, x2, y2) => {
    const b = pen(lane).move_to(x1, y1);
    if (x1 === x2) b.line_to(x2, y2);
    else {
      const my = (y1 + y2) / 2;
      b.cubic_bezier_to(x2, y2, x1, my, x2, my);
    }
  };
  const mid = h / 2;
  const col = row.lane;
  row.incoming.forEach((oid, i) => {
    if (oid === null) return;
    if (oid === row.oid) line(i, laneX(i), 0, laneX(col), mid);
    else line(i, laneX(i), 0, laneX(i), h);
  });
  row.parentLanes.forEach((j, k) => {
    // The first parent continues in this lane; an extra parent's line takes its lane's colour.
    if (k === 0) line(col, laneX(col), mid, laneX(col), h);
    else line(j, laneX(col), mid, laneX(j), h);
  });
  const cell = div().relative().flex_none().w(rowWidth(row) * LANE_W + 4).h(h);
  const paint = /** @type {any} */ (globalThis).window;
  for (const [k, b] of builders) cell.child(paint.paint_path(b.build(), colors[k]).absolute().top(0).left(0).size_full());
  return cell.child(dot(t, laneColor(t, col), laneX(col), mid, isHead, merge));
}

/**
 * HEAD: a ringed dot. Merge: a hollow dot. Any other commit: a filled dot.
 * @param {Record<string, string>} t @param {string} color @param {number} x @param {number} y @param {boolean} isHead @param {boolean} merge
 */
function dot(t, color, x, y, isHead, merge) {
  const r = isHead ? 6 : 4;
  const d = div().absolute().left(x - r).top(y - r).w(r * 2).h(r * 2).rounded_full().flex().items_center().justify_center();
  if (isHead) return d.border_2().border_color(color).bg(t.surface).child(div().w(4).h(4).rounded_full().bg(color));
  if (merge) return d.border_2().border_color(color).bg(t.surface);
  return d.bg(color);
}
