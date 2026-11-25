// @ts-check
// PROTOTYPE — throwaway, lives only on branch prototype/graph-rows. Never merge.
//
// Question (wayfinder ticket "Graph: row look and interaction"): how should a Graph
// row look and behave in the Source Control panel?
//
// Three structurally different variants of the Graph section, mounted below the commit
// box. Switch with the floating pill at the bottom of the panel, or ← / → while the
// panel has focus (not while typing in the commit box).
//
//   A  Single line   VS Code-like one-line rows; click expands files inline; details in a tooltip.
//   B  Two-line      Taller rows (subject / sha·author·date); click expands a detail block + files.
//   C  Drill-in      Dense rows, no author; click replaces the list with a commit page (‹ back).
//
// ASSUMPTION: the data is a hard-coded fixture with branches, merges, tags, remotes and
// an overflowing ref set — the question is the look, not the git plumbing. Toolbar
// actions, file clicks and "Load more…" are stubs that only report what they would do.
// The status strip at the bottom of the section shows the prototype's state, including
// the runtime checks from "Graph: can Herdr/gpui-kit draw the lane graph?".

import { div, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar } from "gpui-base";
import { scrollArea } from "./widgets.js";

// ---------------------------------------------------------------- fixture

const NOW = Math.floor(Date.now() / 1000);
const H = 3600;

/** @typedef {{ oid: string, parents: string[], author: string, email: string, at: number, subject: string, body: string, refs: Ref[], files: File[] }} Commit */
/** @typedef {{ kind: "head" | "local" | "remote" | "tag", name: string }} Ref */
/** @typedef {{ status: string, path: string, oldPath?: string }} File */

let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const hex = () => Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");
const PATHS = ["src/ui/source-control-panel.js", "src/core/repository.js", "src/core/git.js", "src/ui/diff-view.js",
  "src/core/status.js", "test/workbench.test.js", "README.md", "GLOSSARY.md", "src/core/lanes.js", "src/ui/widgets.js",
  "docs/adr/0004-graph-in-panel.md", "src/core/watch-filter.js"];
function files(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const path = PATHS[Math.floor(rnd() * PATHS.length)];
    if (out.some((f) => f.path === path)) continue;
    const r = rnd();
    out.push(r < 0.6 ? { status: "M", path } : r < 0.8 ? { status: "A", path } : r < 0.92 ? { status: "D", path }
      : { status: "R", path, oldPath: path.replace(/(\w+)\.(\w+)$/, "old-$1.$2") });
  }
  return out;
}

/** Newest first, topo order. [name, parents, subject, refs, hoursAgo, author] */
const SPEC = [
  ["a1", ["a2"], "Wire Graph toolbar stubs into the Source Control panel", [["head", "main"]], 1, "Lee Sanderson"],
  ["a2", ["a3", "f1"], "Merge branch 'feature/lanes'", [["remote", "origin/main"]], 3, "Lee Sanderson"],
  ["f1", ["f2"], "Fold lanes over topo order without ever compacting free slots", [["local", "feature/lanes"], ["remote", "origin/feature/lanes"]], 5, "Ada Lovelace"],
  ["a3", ["a4"], "Fix CRLF in diff header", [], 6, "Lee Sanderson"],
  ["f2", ["a4"], "Add lane fixture tests", [], 8, "Ada Lovelace"],
  ["a4", ["a5"], "Release 0.3.0", [["tag", "v0.3.0"], ["local", "release/0.3"], ["remote", "origin/release/0.3"], ["tag", "stable"]], 26, "Lee Sanderson"],
  ["h1", ["a5"], "WIP: hover card experiment (does HoverCard survive a virtual row?)", [["local", "spike/hover-card"]], 28, "Grace Hopper"],
  ["a5", ["a6", "w1"], "Merge pull request #31 from gh/watch-packed-refs", [], 30, "Lee Sanderson"],
  ["w1", ["w2"], "Watch packed-refs as well as loose refs", [["remote", "origin/watch-packed-refs"]], 33, "Grace Hopper"],
  ["d1", ["a6"], "Try a darker lane palette", [["remote", "origin/dark-lanes"]], 34, "Ada Lovelace"],
  ["w2", ["a6"], "Debounce the watcher so a rebase is one refresh", [], 40, "Grace Hopper"],
  ["a6", ["a7"], "Discard asks for confirmation through the shipped dialog", [], 50, "Lee Sanderson"],
  ["a7", ["a8"], "Show ahead/behind against the upstream in the top bar", [], 70, "Lee Sanderson"],
  ["a8", ["a9"], "Inline diff mode", [["tag", "v0.2.0"]], 100, "Lee Sanderson"],
  ["a9", ["b1", "b2"], "Merge branch 'split-diff' (a long subject line that should truncate long before it reaches the badges on the right)", [], 120, "Lee Sanderson"],
  ["b2", ["b3"], "Split diff: pan both sides together", [], 125, "Ada Lovelace"],
  ["b1", ["b3"], "Stage and unstage from the keyboard", [], 130, "Lee Sanderson"],
  ["b3", ["b4"], "Commit box with Ctrl+Enter", [], 150, "Lee Sanderson"],
  ["b4", ["b5"], "Read status with porcelain v2", [["tag", "v0.1.0"]], 200, "Lee Sanderson"],
  ["b5", ["b6"], "Follow the active space", [], 260, "Lee Sanderson"],
  ["b6", ["b7"], "Panel skeleton", [], 300, "Lee Sanderson"],
  ["b7", [], "Initial commit", [], 400, "Lee Sanderson"],
];

/** @type {Commit[]} */
const COMMITS = (() => {
  const oids = Object.fromEntries(SPEC.map(([n]) => [n, hex()]));
  return SPEC.map(([n, ps, subject, refs, ago, author]) => ({
    oid: oids[/** @type {string} */ (n)],
    parents: /** @type {string[]} */ (ps).map((p) => oids[p]),
    author: /** @type {string} */ (author),
    email: `${String(author).split(" ")[0].toLowerCase()}@example.com`,
    at: NOW - /** @type {number} */ (ago) * H,
    subject: /** @type {string} */ (subject),
    body: /** @type {any[]} */ (ps).length > 1 ? "" : "Longer explanation of the change.\nIt wraps over a couple of lines so the detail\nviews have something to show.",
    refs: /** @type {any[]} */ (refs).map(([kind, name]) => ({ kind, name })),
    files: files(1 + Math.floor(rnd() * 6)),
  }));
})();
const HEAD_OID = COMMITS[0].oid;

// ---------------------------------------------------------------- lane fold

/** @typedef {{ commit: Commit, col: number, incoming: (string|null)[], outgoing: (string|null)[], forks: number[] }} LaneRow */

/** The VS Code-style fold from "Graph: history model and lane layout". @param {Commit[]} commits */
function layout(commits) {
  /** @type {(string|null)[]} */
  const lanes = [];
  /** @type {LaneRow[]} */
  const rows = [];
  let width = 1;
  const free = () => {
    const i = lanes.indexOf(null);
    if (i >= 0) return i;
    lanes.push(null);
    return lanes.length - 1;
  };
  for (const commit of commits) {
    const incoming = lanes.slice();
    let col = lanes.indexOf(commit.oid);
    if (col < 0) col = free();
    for (let i = 0; i < lanes.length; i++) if (i !== col && lanes[i] === commit.oid) lanes[i] = null;
    lanes[col] = commit.parents[0] ?? null;
    const forks = [];
    for (const p of commit.parents.slice(1)) {
      let j = lanes.indexOf(p);
      if (j < 0) { j = free(); lanes[j] = p; }
      forks.push(j);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const outgoing = lanes.slice();
    width = Math.max(width, incoming.length, outgoing.length, col + 1);
    rows.push({ commit, col, incoming, outgoing, forks });
  }
  return { rows, width };
}
const LAYOUT = layout(COMMITS);

// ---------------------------------------------------------------- drawing

const LANE_W = 12;
const STROKE = 1.5;
/** @param {Record<string, string>} t */
const palette = (t) => [t.ansi4, t.ansi5, t.ansi2, t.ansi3, t.ansi6, t.ansi1, t.ansi12, t.ansi13, t.ansi10, t.ansi11];
const laneX = (i) => LANE_W / 2 + i * LANE_W + 2;
const cellW = () => LAYOUT.width * LANE_W + 4;

/** Runtime checks the prototype answers as a side effect. */
const checks = { paintPath: "not tried", tooltip: "not tried" };

/**
 * The graph cell for one row: one paint_path layer per lane colour, plus the dot.
 * `row` null-commit = a pass-through row (files, detail, load more) under `row`.
 * @param {Record<string, string>} t @param {LaneRow} row @param {number} h @param {boolean} passThrough
 */
function graphCell(t, row, h, passThrough) {
  const colors = palette(t);
  /** @type {Map<number, any>} */
  const builders = new Map();
  const pb = (lane) => {
    const k = lane % colors.length;
    if (!builders.has(k)) builders.set(k, PathBuilder.stroke(STROKE));
    return builders.get(k);
  };
  const line = (lane, x1, y1, x2, y2) => {
    const b = pb(lane).move_to(x1, y1);
    if (x1 === x2) b.line_to(x2, y2);
    else { const my = (y1 + y2) / 2; b.cubic_bezier_to(x2, y2, x1, my, x2, my); }
  };
  const mid = h / 2;
  if (passThrough) {
    row.outgoing.forEach((v, i) => { if (v !== null) line(i, laneX(i), 0, laneX(i), h); });
  } else {
    const { commit, col } = row;
    row.incoming.forEach((v, i) => {
      if (v === null) return;
      if (v === commit.oid) line(i, laneX(i), 0, laneX(col), mid);
      else line(i, laneX(i), 0, laneX(i), h);
    });
    if (row.outgoing[col] != null) line(col, laneX(col), mid, laneX(col), h);
    for (const j of row.forks) line(j, laneX(col), mid, laneX(j), h);
  }
  const cell = div().relative().flex_none().w(cellW()).h(h);
  try {
    for (const [k, b] of builders) {
      cell.child(/** @type {any} */ (globalThis).window.paint_path(b.build(), colors[k]).absolute().top(0).left(0).size_full());
    }
    checks.paintPath = "ok in virtual rows";
  } catch (e) {
    checks.paintPath = `threw: ${e}`;
  }
  if (!passThrough) cell.child(dot(t, row, mid));
  return cell;
}

/** HEAD = ringed dot, merge = hollow dot, other = filled dot. */
function dot(t, row, mid) {
  const color = palette(t)[row.col % palette(t).length];
  const x = laneX(row.col);
  const isHead = row.commit.oid === HEAD_OID;
  const isMerge = row.commit.parents.length > 1;
  const r = isHead ? 6 : 4;
  const d = div().absolute().left(x - r).top(mid - r).w(r * 2).h(r * 2).rounded_full().flex().items_center().justify_center();
  if (isHead) return d.border_2().border_color(color).bg(t.surface).child(div().w(4).h(4).rounded_full().bg(color));
  if (isMerge) return d.border_2().border_color(color).bg(t.surface);
  return d.bg(color);
}

// ---------------------------------------------------------------- shared bits

const short = (oid) => oid.slice(0, 7);
function ago(at) {
  const s = NOW - at;
  if (s < H) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 24 * H) return `${Math.round(s / H)} h ago`;
  return `${Math.round(s / (24 * H))} days ago`;
}
const RE = /(.*\/)?([^/]+)$/;
const nameOf = (p) => (RE.exec(p)?.[2] ?? p);
const folderOf = (p) => (RE.exec(p)?.[1] ?? "").replace(/\/$/, "");
const LETTER_COLOR = (t, s) => ({ M: t.ansi3, A: t.ansi2, D: t.ansi1, R: t.ansi4 })[s] ?? t.muted;

/**
 * One Ref badge. style "pill" = tinted pill with a glyph, "text" = coloured text only.
 * @param {Record<string, string>} t @param {Ref} ref @param {string} laneColor @param {"pill" | "text"} style
 */
function badge(t, ref, laneColor, style) {
  const glyph = { head: "◉", local: "⎇", remote: "☁", tag: "◆" }[ref.kind];
  const color = ref.kind === "tag" ? t.ansi3 : ref.kind === "remote" ? t.muted : laneColor;
  if (style === "text") return div().flex_none().text_size(11).text_color(color).child(`${glyph} ${ref.name}`);
  return h_flex().flex_none().max_w(140).h(16).px(5).gap(3).items_center().rounded(8).text_size(10)
    .bg(color + "26").text_color(color).when(ref.kind === "head", (e) => e.border_1().border_color(color).font_semibold())
    .child(div().flex_none().child(glyph)).child(div().min_w(0).truncate().child(ref.name));
}

/** Badges with overflow: the first `max`, then "+N" with the rest in a tooltip. */
function badges(t, refs, laneColor, max, style) {
  const row = h_flex().flex_none().gap(3).items_center();
  for (const r of refs.slice(0, max)) row.child(badge(t, r, laneColor, style));
  if (refs.length > max) {
    row.child(div().flex_none().px(4).h(16).flex().items_center().rounded(8).text_size(10).bg(t.raised).text_color(t.muted)
      .child(`+${refs.length - max}`));
  }
  return row;
}

const laneColor = (t, row) => palette(t)[row.col % palette(t).length];
const detailText = (c) => `${c.subject}\n\n${c.oid}\n${c.author} <${c.email}>\n${new Date(c.at * 1000).toLocaleString()} (${ago(c.at)})` +
  (c.refs.length ? `\n${c.refs.map((r) => r.name).join(", ")}` : "") + (c.body ? `\n\n${c.body}` : "");

/** Tries `.tooltip` inside a virtual row and records whether the runtime allows it. */
function withTooltip(el, text) {
  try {
    const out = el.id ? el : el;
    out.tooltip(text);
    checks.tooltip = "accepted in virtual rows (hover to see if it shows)";
  } catch (e) {
    checks.tooltip = `threw: ${e}`;
  }
  return el;
}

// ---------------------------------------------------------------- state

const FILTERS = ["Auto", "All", "Current"];
export const proto = {
  variant: "B",
  collapsed: false,
  /** @type {Set<string>} */
  expanded: new Set(),
  /** @type {string | null} */
  selected: null,
  filter: "Auto",
  /** C: the commit page shown instead of the list. @type {string | null} */
  drill: null,
  menuOpen: false,
  status: "—",
};
const VARIANTS = [["A", "Single line"], ["B", "Two-line"], ["C", "Drill-in"]];

function say(msg) { proto.status = msg; }
function stub(action, ahead, behind) {
  const what = {
    fetch: "git fetch (background-safe: -c credential.interactive=false)",
    pull: `git pull (honours pull.rebase; ↓${behind})`,
    push: `git push (↑${ahead})`,
    current: "scroll to HEAD and select it",
    refresh: "reload the git log snapshot",
  }[action];
  if (action === "current") proto.selected = HEAD_OID;
  say(`stub → would ${what}`);
}

/** Cycles the variant. @param {number} step */
export function cycleVariant(step) {
  const i = VARIANTS.findIndex(([k]) => k === proto.variant);
  proto.variant = VARIANTS[(i + step + VARIANTS.length) % VARIANTS.length][0];
  proto.drill = null;
  proto.menuOpen = false;
  say(`variant ${proto.variant}`);
}

// ---------------------------------------------------------------- the section

/**
 * The Graph section for the current variant.
 * @param {Record<string, string>} t @param {{ ahead: number | null, behind: number | null }} snapshot
 */
export function graphSection(t, snapshot) {
  const ahead = snapshot.ahead ?? 0;
  const behind = snapshot.behind ?? 0;
  const header = proto.variant === "A" ? toolbarA(t, ahead, behind)
    : proto.variant === "B" ? toolbarB(t, ahead, behind)
    : toolbarC(t, ahead, behind);
  const section = v_flex().border_t_1().border_color(t.border).child(header);
  if (proto.collapsed) return section.flex_none();
  section.flex_1().min_h(0);
  if (proto.variant === "C" && proto.menuOpen) section.child(menuC(t, ahead, behind));
  const body = proto.variant === "C" && proto.drill ? commitPage(t) : list(t);
  return section.child(body).child(statusStrip(t));
}

function chevron(t) {
  return div().id("graph-collapse").flex_none().w(14).text_color(t.muted).cursor_pointer()
    .on_click((_e, cx) => { cx.stop_propagation(); proto.collapsed = !proto.collapsed; cx.notify(); })
    .child(proto.collapsed ? "▸" : "▾");
}

/** A glyph button with a tooltip. */
function tool(t, id, glyph, tip, onClick) {
  return div().id(id).flex_none().w(22).h(22).flex().items_center().justify_center().rounded(4)
    .text_size(13).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
    .tooltip(tip)
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(); cx.notify(); })
    .child(glyph);
}

function textButton(t, id, label, onClick, primary = false) {
  return h_flex().id(id).flex_none().h(20).px(8).items_center().rounded(4).text_size(11)
    .bg(primary ? t.accent : t.raised).text_color(primary ? t.accent_foreground : t.foreground)
    .cursor_pointer().hover((s) => s.opacity(0.85))
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(); cx.notify(); })
    .child(label);
}

/** A: one header row — title, filter chip (click cycles), glyph tools with tooltips. */
function toolbarA(t, ahead, behind) {
  return h_flex().flex_none().h(28).px(6).gap(4).items_center().bg(t.chrome).border_b_1().border_color(t.border)
    .child(chevron(t))
    .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child("GRAPH"))
    .child(h_flex().id("filter-chip").flex_none().h(20).px(6).gap(4).items_center().rounded(4).text_size(11)
      .bg(t.raised).cursor_pointer().tooltip("Ref filter: Auto = HEAD + upstream · All · Current")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        proto.filter = FILTERS[(FILTERS.indexOf(proto.filter) + 1) % FILTERS.length];
        say(`filter → ${proto.filter}`);
        cx.notify();
      })
      .child(`⎇ ${proto.filter}`).child(div().text_color(t.dim).child("▾")))
    .child(tool(t, "go-current", "⌖", "Go to current (HEAD)", () => stub("current", ahead, behind)))
    .child(tool(t, "fetch", "⤓", "Fetch", () => stub("fetch", ahead, behind)))
    .child(tool(t, "pull", "↓", `Pull (${behind} behind)`, () => stub("pull", ahead, behind)))
    .child(tool(t, "push", "↑", `Push (${ahead} ahead)`, () => stub("push", ahead, behind)))
    .child(tool(t, "graph-refresh", "⟳", "Refresh", () => stub("refresh", ahead, behind)));
}

/** B: two rows — title + segmented Ref filter, then labelled sync buttons with counts. */
function toolbarB(t, ahead, behind) {
  const seg = (value) => h_flex().id(`seg-${value}`).flex_none().h(18).px(8).items_center().rounded(4).text_size(11)
    .when(proto.filter === value, (e) => e.bg(t.surface).text_color(t.foreground).font_semibold())
    .when(proto.filter !== value, (e) => e.text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground)))
    .on_click((_e, cx) => { cx.stop_propagation(); proto.filter = value; say(`filter → ${value}`); cx.notify(); })
    .child(value);
  return v_flex().flex_none().bg(t.chrome).border_b_1().border_color(t.border)
    .child(h_flex().h(28).px(6).gap(6).items_center()
      .child(chevron(t))
      .child(div().flex_1().text_size(12).font_semibold().child("Graph"))
      .child(h_flex().flex_none().p(2).gap(2).rounded(6).bg(t.raised).children(FILTERS.map(seg))))
    .when(!proto.collapsed, (e) => e.child(h_flex().h(28).px(8).gap(6).items_center()
      .child(textButton(t, "b-fetch", "Fetch", () => stub("fetch", ahead, behind)))
      .child(textButton(t, "b-pull", `Pull ↓${behind}`, () => stub("pull", ahead, behind), behind > 0))
      .child(textButton(t, "b-push", `Push ↑${ahead}`, () => stub("push", ahead, behind), ahead > 0 && behind === 0))
      .child(div().flex_1())
      .child(tool(t, "b-current", "⌖", "Go to current (HEAD)", () => stub("current", ahead, behind)))
      .child(tool(t, "b-refresh", "⟳", "Refresh", () => stub("refresh", ahead, behind)))));
}

/** C: minimal header — title with the filter as text, ↑↓ counts, one ⋯ that opens an action strip. */
function toolbarC(t, ahead, behind) {
  return h_flex().flex_none().h(26).px(6).gap(6).items_center().bg(t.chrome).border_b_1().border_color(t.border)
    .child(chevron(t))
    .child(div().flex_none().text_size(11).font_semibold().text_color(t.muted).child("GRAPH"))
    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`· ${proto.filter}`))
    .child(div().flex_none().text_size(11).text_color(t.dim).child(`↑${ahead} ↓${behind}`))
    .child(tool(t, "c-menu", "⋯", "Graph actions", () => { proto.menuOpen = !proto.menuOpen; }));
}

function menuC(t, ahead, behind) {
  const item = (id, label, fn) => h_flex().id(id).h(22).px(12).items_center().text_size(12).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => { cx.stop_propagation(); fn(); proto.menuOpen = false; cx.notify(); })
    .child(label);
  return v_flex().flex_none().py(4).bg(t.popover ?? t.raised).border_b_1().border_color(t.border)
    .child(item("m-fetch", "Fetch", () => stub("fetch", ahead, behind)))
    .child(item("m-pull", `Pull (${behind} behind)`, () => stub("pull", ahead, behind)))
    .child(item("m-push", `Push (${ahead} ahead)`, () => stub("push", ahead, behind)))
    .child(item("m-current", "Go to current", () => stub("current", ahead, behind)))
    .child(item("m-refresh", "Refresh", () => stub("refresh", ahead, behind)))
    .children(FILTERS.map((f) => item(`m-f-${f}`, `${proto.filter === f ? "●" : "○"}  Ref filter: ${f}`, () => { proto.filter = f; say(`filter → ${f}`); })));
}

// ---------------------------------------------------------------- the list

/** @typedef {{ key: string, kind: "commit" | "file" | "detail" | "more", row: LaneRow, file?: File, h: number }} Item */

/** The flat item list for the current variant. */
function items() {
  /** @type {Item[]} */
  const out = [];
  const v = proto.variant;
  const commitH = v === "A" ? 22 : v === "B" ? 40 : 24;
  for (const row of LAYOUT.rows) {
    const oid = row.commit.oid;
    out.push({ key: `c:${oid}`, kind: "commit", row, h: commitH });
    if (v === "C" || !proto.expanded.has(oid)) continue;
    if (v === "B") {
      const lines = 4 + (row.commit.body ? row.commit.body.split("\n").length + 1 : 0);
      out.push({ key: `d:${oid}`, kind: "detail", row, h: 8 + lines * 16 });
    }
    for (const f of row.commit.files) out.push({ key: `f:${oid}:${f.path}`, kind: "file", row, file: f, h: 22 });
  }
  out.push({ key: "more", kind: "more", row: LAYOUT.rows[LAYOUT.rows.length - 1], h: 26 });
  return out;
}

/** @param {Record<string, string>} t */
function list(t) {
  const all = items();
  const render = (/** @type {Item} */ it) => {
    if (it.kind === "commit") return proto.variant === "A" ? commitRowA(t, it) : proto.variant === "B" ? commitRowB(t, it) : commitRowC(t, it);
    if (it.kind === "file") return fileRow(t, it);
    if (it.kind === "detail") return detailBlock(t, it);
    return h_flex().w_full().h(it.h).items_center().gap(6).pl(cellW() + 6).text_size(12).text_color(t.accent).child("Load more…");
  };
  const vl = v_virtual_list("graph-rows", all.length, all.map((i) => i.h), (i) => all[i].key,
    (range) => all.slice(range.start, range.end).map(render))
    .on_item_click((key, cx) => { onItem(key, all); cx.notify(); })
    .size_full();
  return div().flex_1().min_h(0).relative()
    .child(vl)
    .child(Scrollbar.vertical("graph-rows").absolute().inset_0());
}

function onItem(key, all) {
  const it = all.find((i) => i.key === key);
  if (!it) return;
  const c = it.row.commit;
  if (it.kind === "more") return say("stub → would re-run git log with --max-count=+50 (Load more…)");
  if (it.kind === "file") {
    const f = /** @type {File} */ (it.file);
    const left = c.parents[0] ? short(c.parents[0]) : "EMPTY";
    return say(`stub → would open Diff view ${left}..${short(c.oid)} ${f.oldPath ? f.oldPath + " → " : ""}${f.path}`);
  }
  if (it.kind === "detail") return;
  proto.selected = c.oid;
  if (proto.variant === "C") { proto.drill = c.oid; return say(`drill into ${short(c.oid)}`); }
  if (proto.expanded.has(c.oid)) proto.expanded.delete(c.oid);
  else proto.expanded.add(c.oid);
  say(`${proto.expanded.has(c.oid) ? "expanded" : "collapsed"} ${short(c.oid)} (${c.files.length} files)`);
}

const rowBase = (t, it) => h_flex().w_full().h(it.h).flex_none().items_center().overflow_hidden()
  .when(proto.selected === it.row.commit.oid && it.kind === "commit", (e) => e.bg(t.raised));

/** A: graph | subject | badges (right) | author. Details in a tooltip. */
function commitRowA(t, it) {
  const c = it.row.commit;
  const isHead = c.oid === HEAD_OID;
  const row = rowBase(t, it).gap(6).pr(8).text_size(12)
    .child(graphCell(t, it.row, it.h, false))
    .child(div().flex_1().min_w(0).truncate().when(isHead, (e) => e.font_semibold())
      .when(c.parents.length > 1, (e) => e.text_color(t.muted)).child(c.subject))
    .child(badges(t, c.refs, laneColor(t, it.row), 2, "pill"))
    .child(div().flex_none().max_w(90).truncate().text_size(11).text_color(t.dim).child(c.author.split(" ")[0]));
  return withTooltip(row, detailText(c));
}

/** B: graph | two lines: (badges + subject) / (sha · author · when). */
function commitRowB(t, it) {
  const c = it.row.commit;
  const open = proto.expanded.has(c.oid);
  return rowBase(t, it).gap(6).pr(8)
    .child(graphCell(t, it.row, it.h, false))
    .child(v_flex().flex_1().min_w(0).gap(1)
      .child(h_flex().gap(4).items_center().min_w(0)
        .child(badges(t, c.refs, laneColor(t, it.row), 3, "pill"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).when(c.oid === HEAD_OID, (e) => e.font_semibold()).child(c.subject)))
      .child(h_flex().gap(6).text_size(11).text_color(t.dim)
        .child(div().flex_none().font_family("monospace").child(short(c.oid)))
        .child(div().flex_shrink(1).min_w(0).truncate().child(c.author))
        .child(div().flex_none().child(ago(c.at)))
        .when(c.parents.length > 1, (e) => e.child(div().flex_none().text_color(t.muted).child("merge")))))
    .child(div().flex_none().text_size(10).text_color(t.dim).child(open ? "▾" : "▸"));
}

/** C: graph | refs as coloured text | subject. No author; everything else is on the commit page. */
function commitRowC(t, it) {
  const c = it.row.commit;
  return rowBase(t, it).gap(6).pr(8).text_size(12)
    .child(graphCell(t, it.row, it.h, false))
    .when(c.refs.length > 0, (e) => e.child(badges(t, c.refs, laneColor(t, it.row), 1, "text")))
    .child(div().flex_1().min_w(0).truncate().when(c.oid === HEAD_OID, (e) => e.font_semibold()).child(c.subject))
    .child(div().flex_none().text_size(10).text_color(t.dim).child(ago(c.at).replace(" ago", "")));
}

/** A/B: one changed file under an expanded commit; the lanes pass through. */
function fileRow(t, it) {
  const f = /** @type {File} */ (it.file);
  return h_flex().w_full().h(it.h).flex_none().items_center().gap(6).pr(8).text_size(12).overflow_hidden()
    .bg(t.chrome)
    .child(graphCell(t, it.row, it.h, true))
    .child(div().flex_none().w(14))
    .child(div().flex_none().w(12).text_size(11).font_semibold().text_color(LETTER_COLOR(t, f.status)).child(f.status))
    .child(div().flex_none().child(nameOf(f.path)))
    .child(div().flex_shrink(1).min_w(0).truncate().text_size(11).text_color(t.dim)
      .child(f.oldPath ? `${folderOf(f.path)}  ← ${f.oldPath}` : folderOf(f.path)));
}

/** B: the detail block between an expanded commit and its files. */
function detailBlock(t, it) {
  const c = it.row.commit;
  const lines = [
    [c.subject, t.foreground, true],
    [`${c.oid}`, t.dim, false],
    [`${c.author} <${c.email}>`, t.muted, false],
    [`${new Date(c.at * 1000).toLocaleString()} · ${c.parents.length} parent(s)`, t.muted, false],
    ...(c.body ? [["", t.dim, false], ...c.body.split("\n").map((l) => [l, t.foreground, false])] : []),
  ];
  return h_flex().w_full().h(it.h).flex_none().items_start().gap(6).pr(8).overflow_hidden().bg(t.chrome)
    .child(graphCell(t, it.row, it.h, true))
    .child(v_flex().flex_1().min_w(0).py(4).pl(14)
      .children(lines.map(([text, color, bold]) => div().h(16).truncate().text_size(11).text_color(color)
        .when(!!bold, (e) => e.font_semibold()).child(text || " "))));
}

/** C: the commit page that replaces the list. Ordinary (non-virtual) rows, so each part is clickable. */
function commitPage(t) {
  const c = /** @type {Commit} */ (COMMITS.find((x) => x.oid === proto.drill));
  const row = /** @type {LaneRow} */ (LAYOUT.rows.find((r) => r.commit.oid === c.oid));
  const fileItem = (f) => h_flex().id(`page-f-${f.path}`).h(22).px(10).gap(6).items_center().text_size(12).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => {
      cx.stop_propagation();
      say(`stub → would open Diff view ${c.parents[0] ? short(c.parents[0]) : "EMPTY"}..${short(c.oid)} ${f.path}`);
      cx.notify();
    })
    .child(div().flex_none().w(12).text_size(11).font_semibold().text_color(LETTER_COLOR(t, f.status)).child(f.status))
    .child(div().flex_none().child(nameOf(f.path)))
    .child(div().flex_shrink(1).min_w(0).truncate().text_size(11).text_color(t.dim).child(folderOf(f.path)));
  return v_flex().flex_1().min_h(0)
    .child(h_flex().id("page-back").flex_none().h(24).px(8).gap(6).items_center().text_size(12).text_color(t.accent)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); proto.drill = null; say("back to Graph"); cx.notify(); })
      .child("‹ Graph"))
    .child(scrollArea("graph-page", [
      v_flex().px(10).py(6).gap(4).border_b_1().border_color(t.border)
        .child(div().font_semibold().child(c.subject))
        .child(badges(t, c.refs, laneColor(t, row), 6, "pill"))
        .child(div().text_size(11).text_color(t.muted).child(`${c.author} <${c.email}> · ${ago(c.at)}`))
        .child(div().text_size(11).text_color(t.dim).child(c.oid))
        .when(!!c.body, (e) => e.child(v_flex().pt(4).text_size(12).children(c.body.split("\n").map((l) => div().child(l))))),
      div().px(10).pt(6).pb(2).text_size(11).font_semibold().text_color(t.muted).child(`${c.files.length} FILES CHANGED`),
      ...c.files.map(fileItem),
    ]));
}

function statusStrip(t) {
  return v_flex().flex_none().px(8).py(3).gap(1).bg(t.chrome).border_t_1().border_color(t.border).text_size(10).text_color(t.dim)
    .child(div().truncate().child(`PROTOTYPE ${proto.variant} · filter ${proto.filter} · expanded ${proto.expanded.size} · selected ${proto.selected ? short(proto.selected) : "—"}`))
    .child(div().truncate().child(`paint_path: ${checks.paintPath} · tooltip: ${checks.tooltip}`))
    .child(div().truncate().text_color(t.muted).child(proto.status));
}

/** The floating switcher pill, bottom-centre of the panel. Not part of any design. */
export function switcher(t) {
  const label = VARIANTS.find(([k]) => k === proto.variant)?.[1];
  const arrow = (id, glyph, step) => div().id(id).px(8).cursor_pointer().hover((s) => s.opacity(0.7))
    .on_click((_e, cx) => { cx.stop_propagation(); cycleVariant(step); cx.notify(); })
    .child(glyph);
  return h_flex().absolute().bottom(4).right(6)
    .child(h_flex().h(24).px(4).items_center().rounded(12).bg("#000000dd").text_color("#ffffff").text_size(11).font_semibold()
      .shadow_md()
      .child(arrow("proto-prev", "‹", -1))
      .child(div().px(4).child(`${proto.variant} · ${label}`))
      .child(arrow("proto-next", "›", 1)));
}
