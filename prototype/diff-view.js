// PROTOTYPE: throwaway. Do not build on this file.
// Wayfinder ticket "Diff view rendering: row-pair list, modes, navigation, large files".
//
// Two kinds of copy, told apart by props().view:
//   "panel" (default): a launcher listing the repository's changes. Clicking one opens
//                      its Diff view in a new Herdr tab, as decided by the layout ticket.
//   "diff":            the Diff view under test.
//
// The Diff view is one v_virtual_list of rows. In side-by-side mode each row is a
// left/right pair, so both sides scroll together for free. All other choices are
// prototype knobs on the accent bar at the bottom of a diff tab, kept in
// shared("gitwb.diffproto") so every open tab follows them and hot reloads keep them:
//   pairing:   "index" (i-th deletion beside i-th addition) | "none" (deletions, then additions)
//   intraline: highlight the changed part of a modified line, or not
//   long:      "truncate" | "hscroll" | "wrap" (hard wrap at the estimated column count)
//   onesided:  new/deleted/untracked files: "inline" automatically, or "keep" side-by-side
//   limit:     line count above which only changed sections are shown (decided: whole file up to a limit)
//
// Keys inside a diff tab: n / p, alt-down / alt-up, f7 / shift-f7 = next / previous change;
// i = toggle inline / side-by-side; w = cycle long-line handling; r = reload.
//
// Read-only: it runs git diff, git show and readTextFile and never changes the repository.
// Sample data: `node scripts/prototype-sample-repo.mjs`, then pick "Repo: sample" in the launcher.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, exec, readTextFile, theme, settings, run, props, shared, setShared, home } from "herdr";

const MOD = "herdr-app-git-workbench";
const PROTO = "gitwb.diffproto";
const SAMPLE = () => `${home().replace(/\\/g, "/")}/gitwb-diff-sample-PROTOTYPE`;

const DEFAULTS = { mode: "side", pairing: "index", intraline: true, long: "pan", onesided: "keep", limit: 5000, repo: "active" };
const LONG = ["pan", "truncate", "hscroll", "wrap"];
const proto = () => ({ ...DEFAULTS, ...(shared(PROTO) ?? {}) });
const setProto = (patch) => setShared(PROTO, { ...proto(), ...patch });
const cycle = (list, v) => list[(list.indexOf(v) + 1) % list.length];

const base = (p) => p.split("/").pop();
const dir = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
const fontSize = () => Number(settings().font_size ?? 13);
const rowH = () => Math.ceil(fontSize() * 1.6);
const charW = () => fontSize() * 0.6;
const untab = (s) => { let out = ""; for (const ch of s) out += ch === "\t" ? " ".repeat(4 - (out.length % 4)) : ch; return out; };

// ---------- repository and loading ----------

function parseStatus(out) {
  const parts = out.split("\0");
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith("1 ") || p.startsWith("2 ")) {
      const f = p.split(" "), xy = f[1];
      const path = f.slice(p[0] === "1" ? 8 : 9).join(" ");
      const orig = p[0] === "2" ? parts[++i] : null;
      if (xy[0] !== ".") files.push({ side: "staged", path, orig, status: xy[0] });
      if (xy[1] !== ".") files.push({ side: "unstaged", path, orig: null, status: xy[1] });
    } else if (p.startsWith("? ")) files.push({ side: "untracked", path: p.slice(2), orig: null, status: "U" });
    else if (p.startsWith("u ")) files.push({ side: "conflict", path: p.split(" ").slice(10).join(" "), orig: null, status: "!" });
  }
  return files;
}

async function loadFiles(which) {
  let folder = which === "sample" ? SAMPLE() : spaces().find((s) => s.active)?.folder;
  const on = which === "sample" ? null : spaces().find((s) => s.active)?.machine ?? null;
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder || undefined, on });
  if (top.code !== 0) return { error: which === "sample" ? "No sample repo: run node scripts/prototype-sample-repo.mjs" : `Not a Git repository: ${folder}` };
  const root = top.stdout.trim();
  const st = await exec("git", ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: root, on });
  return { root, on, files: parseStatus(st.stdout) };
}

// Diff target, in the shape the Phase 2 constraints ticket fixed: left/right sides plus paths.
function targetFor(root, on, f) {
  const sides = { staged: ["HEAD", "index"], unstaged: ["index", "worktree"], untracked: [null, "worktree"], conflict: ["index", "worktree"] }[f.side];
  return { root, on, left: sides[0], right: sides[1], oldPath: f.orig ?? f.path, newPath: f.path, status: f.status, side: f.side };
}

async function countLines(t) {
  // Size of the larger side decides whole file versus changed sections.
  const count = (s) => (s == null ? 0 : s.split("\n").length);
  const show = async (rev, path) => {
    const r = await exec("git", ["show", `${rev === "index" ? "" : rev}:${path}`], { cwd: t.root, on: t.on });
    return r.code === 0 ? r.stdout : null;
  };
  const read = (side, path) => (side === "worktree" ? readTextFile(`${t.root}/${path}`, { on: t.on }).catch(() => null) : side ? show(side, path) : null);
  const [a, b] = await Promise.all([read(t.left, t.oldPath), read(t.right, t.newPath)]);
  return Math.max(count(a), count(b));
}

async function loadPatch(t, limit) {
  const lines = await countLines(t);
  const whole = lines <= limit;
  const ctx = whole ? "-U99999999" : "-U3";
  const common = ["--no-optional-locks", "diff", "--no-color", "--no-ext-diff", ctx];
  let args;
  if (t.left === null) args = [...common, "--no-index", "--", "/dev/null", t.newPath];
  else if (t.left === "HEAD") args = [...common, "--cached", "-M", "--", ...(t.oldPath !== t.newPath ? [t.oldPath] : []), t.newPath];
  else args = [...common, "--", t.newPath];
  const started = Date.now();
  const r = await exec("git", args, { cwd: t.root, on: t.on });
  return { text: r.stdout, whole, lines, ms: Date.now() - started, err: r.code > 1 ? r.stderr : null };
}

// ---------- the diff model ----------

function parsePatch(text) {
  const out = { header: {}, rows: [], adds: 0, dels: 0 };
  const lines = text.replace(/\n$/, "").split("\n");
  let i = 0, a = 0, b = 0, lastOldEnd = 1, lastNewEnd = 1;
  for (; i < lines.length && !lines[i].startsWith("@@"); i++) {
    const l = lines[i];
    if (l.startsWith("Binary files")) out.header.binary = true;
    else if (l.startsWith("new file mode")) out.header.added = true;
    else if (l.startsWith("deleted file mode")) out.header.deleted = true;
    else if (l.startsWith("rename from ")) out.header.renameFrom = l.slice(12);
    else if (l.startsWith("similarity index ")) out.header.similarity = l.slice(17);
    else if (l.startsWith("old mode ")) out.header.oldMode = l.slice(9);
    else if (l.startsWith("new mode ")) out.header.newMode = l.slice(9);
  }
  for (; i < lines.length; i++) {
    const l = lines[i];
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(l);
    if (m) {
      a = +m[1]; b = +m[3];
      const gap = a - lastOldEnd;
      if (gap > 0) out.rows.push({ kind: "gap", count: gap, a: lastOldEnd, b: lastNewEnd, title: m[5].trim() });
      continue;
    }
    const k = l[0], body = untab(l.slice(1).replace(/\r$/, "␍"));
    if (k === " ") out.rows.push({ kind: "ctx", a: a++, b: b++, text: body });
    else if (k === "-") { out.rows.push({ kind: "del", a: a++, text: body }); out.dels++; }
    else if (k === "+") { out.rows.push({ kind: "add", b: b++, text: body }); out.adds++; }
    else if (k === "\\") { const prev = out.rows[out.rows.length - 1]; if (prev) prev.noeol = true; }
    lastOldEnd = a; lastNewEnd = b;
  }
  out.tail = { a: lastOldEnd, b: lastNewEnd };
  return out;
}

// Common prefix and suffix of a modified pair: the middle is what changed.
function intraline(x, y) {
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  return { p, s };
}

// Side-by-side rows. A change block is a run of deletions followed by additions.
function pairRows(rows, pairing) {
  const out = [], anchors = [];
  for (let i = 0; i < rows.length;) {
    const r = rows[i];
    if (r.kind === "ctx") { out.push({ kind: "ctx", L: r, R: r }); i++; continue; }
    if (r.kind === "gap") { out.push(r); i++; continue; }
    const dels = [], adds = [];
    while (i < rows.length && rows[i].kind === "del") dels.push(rows[i++]);
    while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++]);
    anchors.push(out.length);
    if (pairing === "index") {
      for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
        const L = dels[j] ?? null, R = adds[j] ?? null;
        out.push({ kind: L && R ? "mod" : L ? "del" : "add", L, R, block: anchors.length - 1 });
      }
    } else {
      for (const L of dels) out.push({ kind: "del", L, R: null, block: anchors.length - 1 });
      for (const R of adds) out.push({ kind: "add", L: null, R, block: anchors.length - 1 });
    }
  }
  return { rows: out, anchors };
}

// Inline rows, with the same blocks marked for navigation and intra-line pairing.
function inlineRows(rows) {
  const out = [], anchors = [];
  for (let i = 0; i < rows.length;) {
    const r = rows[i];
    if (r.kind === "ctx" || r.kind === "gap") { out.push(r); i++; continue; }
    const dels = [], adds = [];
    while (i < rows.length && rows[i].kind === "del") dels.push(rows[i++]);
    while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++]);
    anchors.push(out.length);
    const block = anchors.length - 1;
    dels.forEach((d, j) => out.push({ ...d, block, pair: adds[j] ?? null }));
    adds.forEach((d, j) => out.push({ ...d, block, pair: dels[j] ?? null }));
  }
  return { rows: out, anchors };
}

// Hard wrap to `cols` characters; at least one chunk.
function chunks(text, cols) {
  if (!text) return [""];
  const out = [];
  for (let i = 0; i < text.length; i += cols) out.push(text.slice(i, i + cols));
  return out;
}

// ---------- shared UI bits ----------

const statusColor = (t, s) => ({ "!": t.ansi1, U: t.ansi2, A: t.ansi2, M: t.ansi3, D: t.ansi1, R: t.ansi4 }[s] ?? t.muted);

function chip(t, id, label, onClick, opts = {}) {
  return div().id(id).px(8).h(22).flex().flex_none().items_center().rounded(11).text_size(11).cursor_pointer()
    .bg(opts.on === false ? t.raised : t.accent).text_color(opts.on === false ? t.muted : t.accent_foreground)
    .hover((s) => s.opacity(0.85)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);
}

function iconButton(t, id, glyph, onClick, disabled) {
  return div().id(id).flex_none().w(24).h(24).flex().items_center().justify_center().rounded(4).text_size(13)
    .text_color(disabled ? t.dim : t.muted)
    .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
    .child(glyph);
}

// ---------- launcher panel ----------

class Launcher {
  constructor(owner, cx) { this.state = null; this.load(cx); }
  load(cx) {
    this.loadedFor = proto().repo;
    cx.spawn(async (cx) => { try { this.state = await loadFiles(this.loadedFor); } catch (e) { this.state = { error: String(e) }; } cx.notify(); });
  }
  open(f) {
    const s = this.state, d = targetFor(s.root, s.on, f);
    run("tab.new", { name: `Δ ${base(f.path)}${f.side === "staged" ? " (staged)" : ""}`, mod: MOD, props: { view: "diff", diff: d } });
  }
  render(cx) {
    const t = theme(), p = proto();
    if (this.loadedFor !== p.repo) this.load(cx);
    const s = this.state;
    const rows = !s ? [div().p(10).text_color(t.dim).child("Loading…")]
      : s.error ? [div().p(10).text_color(t.ansi1).child(s.error)]
      : s.files.map((f) => h_flex().id(`f-${f.side}-${f.path}`).h(26).flex_none().px(10).gap(8).items_center().cursor_pointer().hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => this.open(f))
        .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(statusColor(t, f.status)).child(f.status))
        .child(h_flex().flex_1().min_w(0).child(div().truncate().text_color(t.dim).child(dir(f.path))).child(div().flex_none().child(base(f.path))))
        .child(div().text_size(10).text_color(t.dim).child(f.side)));
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13).text_color(t.foreground)
      .child(h_flex().flex_none().h(34).px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Diff view prototype"))
        .child(div().flex_1())
        .child(iconButton(t, "reload", "↻", (cx) => this.load(cx))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("files").absolute().inset_0().overflow_y_scroll().children(rows))
        .child(Scrollbar.vertical("files").absolute().inset_0()))
      .child(h_flex().flex_none().gap(4).p(6).border_t(2).border_color(t.accent).bg(t.canvas).items_center()
        .child(div().text_size(10).font_semibold().text_color(t.accent).child("PROTOTYPE"))
        .child(chip(t, "repo", `Repo: ${p.repo} ▸`, () => setProto({ repo: cycle(["active", "sample"], p.repo) }))));
  }
}

// ---------- the Diff view ----------

class DiffView {
  constructor(owner, cx) {
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.model = null; this.meta = null; this.error = null; this.current = 0; this.loadedLimit = null;
    this.pan = 0; this.bodyW = null; this.drag = null;
    this.handle.focus();
    this.load(cx);
  }

  load(cx) {
    const d = props().diff, limit = proto().limit;
    this.loadedLimit = limit;
    cx.spawn(async (cx) => {
      try {
        const r = await loadPatch(d, limit);
        this.meta = r; this.error = r.err; this.model = parsePatch(r.text);
      } catch (e) { this.error = String(e); }
      cx.notify();
    });
  }

  effectiveMode() {
    const p = proto(), h = this.model?.header ?? {}, d = props().diff;
    const onesided = h.added || h.deleted || d.left === null;
    return onesided && p.onesided === "inline" ? "inline" : p.mode;
  }

  view() {
    const p = proto(), mode = this.effectiveMode();
    const key = `${mode}|${p.pairing}|${this.model ? this.model.rows.length : 0}`;
    if (this.viewKey !== key && this.model) {
      this.viewKey = key;
      this.built = mode === "side" ? pairRows(this.model.rows, p.pairing) : inlineRows(this.model.rows);
      this.built.longest = Math.max(1, ...this.model.rows.map((r) => (r.text ?? "").length));
      this.current = Math.min(this.current, Math.max(0, this.built.anchors.length - 1));
    }
    return this.built;
  }

  go(delta, cx) {
    const b = this.view();
    if (!b || !b.anchors.length) return;
    this.current = (this.current + delta + b.anchors.length) % b.anchors.length;
    this.scroll.scroll_to_item(b.anchors[this.current], "center");
    if (proto().long === "pan") this.panToChange(b);
    cx.notify();
  }

  // Pan so the first changed column of the current change is on screen.
  panToChange(b) {
    const mode = this.effectiveMode(), cols = this.textCols(mode);
    let first = Infinity;
    const lead = (s) => (s ?? "").length - (s ?? "").trimStart().length;
    for (const r of b.rows) {
      if (r.block !== this.current) continue;
      if (mode === "side") {
        if (r.L && r.R) first = Math.min(first, intraline(r.L.text, r.R.text).p);
        else first = Math.min(first, lead((r.L ?? r.R).text));
      } else first = Math.min(first, r.pair ? (r.kind === "del" ? intraline(r.text, r.pair.text).p : intraline(r.pair.text, r.text).p) : lead(r.text));
    }
    if (first === Infinity) return;
    if (first < this.pan + 4 || first > this.pan + cols - 12) this.setPan(first - 12);
  }

  maxPan() { return Math.max(0, (this.built?.longest ?? 0) - this.textCols(this.effectiveMode()) + 4); }
  setPan(v) { this.pan = Math.round(Math.max(0, Math.min(this.maxPan(), v))); }

  onKey(e, cx) {
    const k = e.keystroke, p = proto();
    if (k === "n" || k === "alt-down" || k === "f7") this.go(1, cx);
    else if (k === "p" || k === "alt-up" || k === "shift-f7") this.go(-1, cx);
    else if (k === "i") setProto({ mode: p.mode === "side" ? "inline" : "side" });
    else if (k === "w") setProto({ long: cycle(LONG, p.long) });
    else if (k === "r") this.load(cx);
    else if (p.long === "pan" && (k === "right" || k === "left")) { this.setPan(this.pan + (k === "right" ? 8 : -8)); cx.notify(); }
    else if (p.long === "pan" && k === "home") { this.setPan(0); cx.notify(); }
    else return;
    cx.stop_propagation();
  }

  onWheel(e, cx) {
    if (e.bounds && e.bounds.width !== this.bodyW) this.bodyW = e.bounds.width;
    if (proto().long !== "pan") return;
    let dx = e.delta.x;
    if (!dx && e.modifiers.shift) dx = e.delta.y;
    if (!dx || Math.abs(dx) < Math.abs(e.delta.y) && !e.modifiers.shift) return;
    this.setPan(this.pan - dx / charW());
    cx.stop_propagation();
    cx.notify();
  }

  // --- geometry ---
  gutterW() { return Math.ceil(Math.max(4, String(this.meta?.lines ?? 0).length) * charW()) + 12; }
  // Width of the diff body: measured from mouse events over it, estimated from the window until then.
  bodyWidth() { return this.bodyW ?? (globalThis.window?.viewport_size?.().width ?? 1400) - 300; }
  // Text columns per side (side by side) or for the one text column (inline).
  textCols(mode) {
    const usable = this.bodyWidth() - 16; // vertical scrollbar
    const perSide = mode === "side" ? (usable - 2 * this.gutterW() - 8) / 2 : usable - 2 * this.gutterW() - 20;
    return Math.max(20, Math.floor(perSide / charW()) - 1);
  }

  // --- cells ---
  textCell(t, text, kind, pairText, flexOne, intra) {
    const strong = kind === "add" ? t.ansi2 + "55" : t.ansi1 + "55";
    const pan = proto().long === "pan" ? this.pan : 0;
    const el = h_flex().min_w(0).overflow_hidden().whitespace_nowrap();
    const sized = flexOne ? el.flex_1() : el.flex_none();
    // Segments of the whole line, then cut `pan` columns off the front.
    let segs = [{ s: text, hl: false }];
    if (intra && pairText != null && (kind === "add" || kind === "del")) {
      const { p, s } = kind === "del" ? intraline(text, pairText) : intraline(pairText, text);
      segs = [{ s: text.slice(0, p), hl: false }, { s: text.slice(p, text.length - s), hl: true }, { s: text.slice(text.length - s), hl: false }];
    }
    let skip = pan;
    segs = segs.map((g) => { const cut = Math.min(skip, g.s.length); skip -= cut; return { ...g, s: g.s.slice(cut) }; }).filter((g) => g.s.length);
    const hidden = pan > 0 && text.length > 0 && text.slice(0, pan).trim().length > 0;
    return sized
      .when(pan > 0, (e) => e.child(div().w(charW()).flex_none().text_color(t.accent).child(hidden ? "‹" : "")))
      .children(segs.length ? segs.map((g, i) => (i === segs.length - 1 ? div().truncate() : div().flex_none()).when(g.hl, (e) => e.bg(strong).rounded(2)).child(g.s)) : [div().child(" ")]);
  }

  rowLen(r) { return r.kind === "gap" ? 0 : r.L !== undefined || r.R !== undefined ? Math.max(r.L?.text.length ?? 0, r.R?.text.length ?? 0) : (r.text ?? "").length; }

  // Our own horizontal scrollbar for pan mode: click or drag the track; the thumb is the visible share.
  panBar(t, mode) {
    const cols = this.textCols(mode), total = cols + this.maxPan();
    const share = Math.max(0.05, cols / total), at = this.pan / Math.max(1, total);
    const toPan = (x, b) => this.setPan(((x - b.x) / b.width) * total - cols / 2);
    return h_flex().id("pan-bar").flex_none().h(12).px(4).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .child(div().id("pan-track").flex_1().h(8).relative().rounded(4).bg(t.raised).cursor_pointer()
        .on_mouse_down("left", (e, cx) => { if (e.bounds) { this.drag = e.bounds; toPan(e.position.x, e.bounds); cx.notify(); } })
        .child(div().absolute().top(0).h(8).rounded(4).bg(t.muted).left(`${(at * 100).toFixed(2)}%`).w(`${(share * 100).toFixed(2)}%`)));
  }

  // Hard-wrapped lines, each exactly one row tall so the row size the list was given holds.
  wrapped(lines) {
    return v_flex().flex_1().min_w(0).overflow_hidden()
      .children(lines.map((l) => div().h(rowH()).line_height(rowH()).flex_none().overflow_hidden().whitespace_nowrap().child(l || " ")));
  }

  gutter(t, n, kind) {
    return div().w(this.gutterW()).flex_none().pr(8).text_right().text_color(kind === "ctx" ? t.dim : t.muted).child(n == null ? "" : String(n));
  }

  bg(t, kind) { return kind === "add" ? t.ansi2 + "1c" : kind === "del" ? t.ansi1 + "1c" : null; }

  gapRow(t, r, h) {
    return h_flex().w_full().h(h).flex_none().px(12).gap(8).items_center().bg(t.raised).text_color(t.dim).text_size(11)
      .child(div().child(`⋯ ${r.count.toLocaleString()} unchanged line${r.count === 1 ? "" : "s"}`))
      .when(!!r.title, (e) => e.child(div().truncate().text_color(t.muted).child(r.title)));
  }

  marker(t, block) { // left accent bar on the change the navigator is on
    return div().w(3).h_full().flex_none().when(block === this.current, (e) => e.bg(t.accent));
  }

  sideRow(t, row, h, cols, hscrollW) {
    const p = proto();
    if (row.kind === "gap") return this.gapRow(t, row, h);
    const half = (cell, side) => {
      const kind = row.kind === "ctx" ? "ctx" : cell ? (side === "L" ? "del" : "add") : "empty";
      const pairCell = side === "L" ? row.R : row.L;
      const lines = p.long === "wrap" ? chunks(cell?.text ?? "", cols) : [cell?.text ?? ""];
      const tint = kind === "empty" ? t.canvas : this.bg(t, kind);
      const content = p.long === "wrap"
        ? this.wrapped(lines)
        : this.textCell(t, cell?.text ?? "", kind, row.kind === "mod" ? pairCell?.text : null, p.long !== "hscroll", p.intraline && row.kind === "mod");
      return h_flex().h_full().items_start().overflow_hidden()
        .when(p.long === "hscroll", (e) => e.w(hscrollW).flex_none()).when(p.long !== "hscroll", (e) => e.flex_1().min_w(0))
        .when(!!tint, (e) => e.bg(tint))
        .child(this.gutter(t, side === "L" ? cell?.a : cell?.b, kind))
        .child(content)
        .when(!!cell?.noeol, (e) => e.child(div().flex_none().px(4).text_color(t.ansi1).child("⊘ no newline")));
    };
    return h_flex().w_full().h(h).flex_none().items_start().overflow_hidden()
      .child(this.marker(t, row.block))
      .child(half(row.L, "L"))
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(half(row.R, "R"));
  }

  inlineRow(t, row, h, cols, hscrollW) {
    const p = proto();
    if (row.kind === "gap") return this.gapRow(t, row, h);
    const lines = p.long === "wrap" ? chunks(row.text, cols) : [row.text];
    const content = p.long === "wrap"
      ? this.wrapped(lines)
      : this.textCell(t, row.text, row.kind, row.pair?.text, p.long !== "hscroll", p.intraline);
    return h_flex().w_full().h(h).flex_none().items_start().overflow_hidden()
      .when(p.long === "hscroll", (e) => e.min_w(hscrollW))
      .when(!!this.bg(t, row.kind), (e) => e.bg(this.bg(t, row.kind)))
      .child(this.marker(t, row.block))
      .child(this.gutter(t, row.a, row.kind))
      .child(this.gutter(t, row.b, row.kind))
      .child(div().w(14).flex_none().text_color(row.kind === "add" ? t.ansi2 : row.kind === "del" ? t.ansi1 : t.dim).child(row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""))
      .child(content)
      .when(!!row.noeol, (e) => e.child(div().flex_none().px(4).text_color(t.ansi1).child("⊘ no newline")));
  }

  // --- header ---
  header(t, mode) {
    const d = props().diff, h = this.model?.header ?? {}, b = this.view(), p = proto();
    const sideLabel = { staged: "Staged", unstaged: "Unstaged", untracked: "Untracked", conflict: "Conflict" }[d.side];
    const badge = (text, color) => div().flex_none().px(6).rounded(4).text_size(10).bg(color + "33").text_color(color).child(text);
    const n = b?.anchors.length ?? 0;
    const seg = (id, label, on, onClick) => div().id(id).px(10).h(22).flex().items_center().rounded(5).text_size(11).cursor_pointer()
      .when(on, (e) => e.bg(t.background).text_color(t.foreground).font_semibold()).when(!on, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);
    const forcedInline = mode === "inline" && p.mode === "side";
    const top = h_flex().flex_none().h(38).px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.surface)
      .child(div().w(18).h(18).flex_none().rounded(4).bg(statusColor(t, d.status) + "33").flex().items_center().justify_center().text_size(10).font_semibold().text_color(statusColor(t, d.status)).child(d.status))
      .child(h_flex().min_w(0).flex_shrink(1).child(div().truncate().text_color(t.dim).child(dir(d.newPath))).child(div().flex_none().font_semibold().child(base(d.newPath))))
      .when(d.oldPath !== d.newPath, (e) => e.child(div().flex_shrink(1).min_w(0).truncate().text_size(11).text_color(t.dim).child(`← ${d.oldPath}${h.similarity ? ` (${h.similarity})` : ""}`)))
      .child(badge(sideLabel, d.side === "staged" ? t.ansi2 : t.ansi3))
      .when(!!this.model && !h.binary, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${this.model.adds}`)).child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${this.model.dels}`)))
      .child(div().flex_1())
      .when(n > 0, (e) => e
        .child(iconButton(t, "prev", "↑", (cx) => this.go(-1, cx)))
        .child(div().flex_none().text_size(11).text_color(t.muted).child(`Change ${this.current + 1} of ${n}`))
        .child(iconButton(t, "next", "↓", (cx) => this.go(1, cx))))
      .child(h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.chrome)
        .child(seg("m-side", "Side by side", mode === "side", () => setProto({ mode: "side" })))
        .child(seg("m-inline", "Inline", mode === "inline", () => setProto({ mode: "inline" }))))
      .child(iconButton(t, "reload", "↻", (cx) => this.load(cx)));
    // Notices for special cases, one thin band under the header.
    const notes = [];
    if (h.binary) notes.push("Binary file: no text diff");
    if (h.added || d.left === null) notes.push(d.left === null ? "Untracked file: every line is new" : "New file");
    if (h.deleted) notes.push("Deleted file");
    if (this.meta && !this.meta.whole) notes.push(`Large file (${this.meta.lines.toLocaleString()} lines, over the ${p.limit.toLocaleString()} limit): showing changed sections only`);
    if (h.oldMode) notes.push(`Mode ${h.oldMode} → ${h.newMode}`);
    if (forcedInline) notes.push("Shown inline because one side is empty");
    return v_flex().flex_none().child(top)
      .when(notes.length > 0, (e) => e.child(h_flex().flex_none().px(12).py(3).gap(16).bg(t.raised).border_b(1).border_color(t.border).text_size(11).text_color(t.muted).children(notes.map((x) => div().child(x)))));
  }

  protoBar(t) {
    const p = proto();
    const m = this.meta;
    return h_flex().flex_none().flex_wrap().gap(4).p(6).items_center().border_t(2).border_color(t.accent).bg(t.canvas)
      .child(div().text_size(10).font_semibold().text_color(t.accent).child("PROTOTYPE"))
      .child(chip(t, "pairing", `Pairing: ${p.pairing} ▸`, () => setProto({ pairing: cycle(["index", "none"], p.pairing) })))
      .child(chip(t, "intra", `Intra-line: ${p.intraline ? "on" : "off"}`, () => setProto({ intraline: !p.intraline })))
      .child(chip(t, "long", `Long lines: ${p.long} ▸`, () => setProto({ long: cycle(LONG, p.long) })))
      .child(chip(t, "onesided", `New/deleted: ${p.onesided} ▸`, () => setProto({ onesided: cycle(["inline", "keep"], p.onesided) })))
      .child(chip(t, "limit", `Limit: ${p.limit} lines ▸`, (cx) => { setProto({ limit: cycle([500, 5000, 50000], p.limit) }); }))
      .child(div().flex_1())
      .child(div().text_size(10).text_color(t.dim).child(m ? `${m.whole ? "whole file" : "changed sections"} · ${this.model?.rows.length ?? 0} rows · git ${m.ms} ms · keys n/p i w r, ←/→ home pans` : ""));
  }

  render(cx) {
    const t = theme(), p = proto();
    if (this.loadedLimit !== p.limit) this.load(cx);
    const mode = this.effectiveMode();
    const h = this.model?.header ?? {};
    let body;
    if (this.error && !this.model) body = div().p(16).text_color(t.ansi1).child(this.error);
    else if (!this.model) body = div().p(16).text_color(t.dim).child("Loading diff…");
    else if (h.binary) body = v_flex().p(24).gap(6).text_color(t.muted).child(div().text_size(14).child("Binary file changed")).child(div().text_size(11).text_color(t.dim).child("No text diff is shown for binary files."));
    else if (!this.model.rows.length) body = div().p(16).text_color(t.dim).child("No text changes (mode or whitespace only?)");
    else {
      const b = this.view(), rows = b.rows, base = rowH();
      const cols = this.textCols(mode);
      const sizes = p.long === "wrap"
        ? rows.map((r) => (r.kind === "gap" ? base : mode === "side" ? Math.max(chunks(r.L?.text ?? "", cols).length, chunks(r.R?.text ?? "", cols).length) * base : chunks(r.text, cols).length * base))
        : base;
      const sideW = Math.ceil(b.longest * charW()) + this.gutterW() + 24;
      const hscrollW = mode === "side" ? sideW : sideW + this.gutterW() + 14;
      const list = v_virtual_list("diff-rows", rows.length, sizes, (i) => String(i),
        (range) => rows.slice(range.start, range.end).map((r, j) => {
          const hgt = Array.isArray(sizes) ? sizes[range.start + j] : sizes;
          return mode === "side" ? this.sideRow(t, r, hgt, cols, sideW) : this.inlineRow(t, r, hgt, cols, hscrollW);
        })).track_scroll(this.scroll).size_full()
        // A vertical list takes its width from one measured row; make that the longest one.
        .with_item_to_measure_index(Math.max(0, rows.findIndex((r) => this.rowLen(r) === b.longest)));
      const scroller = p.long === "hscroll"
        ? div().id("diff-x").size_full().overflow_x_scrollbar().child(div().w(mode === "side" ? 2 * sideW + 4 : hscrollW).h_full().child(list))
        : list;
      body = v_flex().flex_1().min_h(0)
        .child(div().flex_1().min_h(0).relative()
          .on_mouse_move((e, cx) => {
            if (e.bounds && Math.abs(e.bounds.width - (this.bodyW ?? 0)) > 1) { this.bodyW = e.bounds.width; cx.notify(); }
          })
          .on_scroll_wheel((e, cx) => this.onWheel(e, cx))
          .child(scroller)
          .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0()))
        .when(p.long === "pan" && this.maxPan() > 0, (e) => e.child(this.panBar(t, mode)));
    }
    return v_flex().id("diff").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12)
      .on_mouse_down("left", (_e, cx) => this.handle.focus())
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        const total = this.textCols(mode) + this.maxPan();
        this.setPan(((e.position.x - this.drag.x) / this.drag.width) * total - this.textCols(mode) / 2);
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { this.drag = null; })
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(this.header(t, mode))
      .child(v_flex().flex_1().min_h(0).font_family(settings().font_family ?? "monospace").text_size(fontSize()).child(body))
      .child(this.protoBar(t));
  }
}

const KINDS = { panel: Launcher, diff: DiffView };

export default class DiffViewPrototype extends View {
  init(_props, cx) { this.impl = new (KINDS[props()?.view ?? "panel"] ?? Launcher)(this, cx); }
  render(cx) { return this.impl.render(cx); }
}
