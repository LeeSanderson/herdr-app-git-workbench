// PROTOTYPE: throwaway. Do not build on this file.
// Wayfinder ticket "Workbench layout: Source Control panel and where diffs open".
//
// Three structurally different Source Control panel variants (A, B, C) and three
// Diff view placements (a Herdr tab per file, one Diffs tab with a file switcher, a
// split pane), switchable from the accent-coloured prototype bar at the bottom of the
// panel. The choice is kept in shared("gitwb.proto"), so it survives hot reloads.
//
// Also probes the discard confirmation round trip:
//   "confirm": the shipped confirm mod runs `herdr-app-git-workbench.discard`, which
//              should arrive through nextCommand(). The log shows exactly what arrives.
//   "self":    an overlay of this mod resolves a promise kept in module scope.
//
// Stage, unstage, discard and commit are stubs: they change in-memory state only
// and never touch the repository.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, TextareaState, Textarea } from "gpui-base";
import {
  spaces, panes, focused, exec, readTextFile, theme, settings, run, props,
  openOverlay, closeOverlay, nextCommand, shared, setShared, notify, checking,
} from "herdr";

const MOD = "herdr-app-git-workbench";
const PROTO = "gitwb.proto";
const DIFFS = "gitwb.diffs";

// Module scope, shared by every copy (docked panel, diff tabs and panes, overlays).
// This is what the "self" discard probe tests.
const pendingAsks = new Map();
let askSeq = 0;
const moduleLog = [];
let copySeq = 0;
function log(msg) {
  moduleLog.unshift(`${new Date().toLocaleTimeString()}  ${msg}`);
  if (moduleLog.length > 14) moduleLog.length = 14;
}

const DEFAULTS = { panel: "A", placement: "tab", discard: "confirm", data: "auto", log: true };
const proto = () => ({ ...DEFAULTS, ...(shared(PROTO) ?? {}) });
const setProto = (patch) => setShared(PROTO, { ...proto(), ...patch });
const cycle = (list, v) => list[(list.indexOf(v) + 1) % list.length];

const GROUPS = [
  ["conflicts", "Conflicts"],
  ["staged", "Staged"],
  ["changes", "Changes"],
  ["untracked", "Untracked"],
];
const base = (p) => p.split("/").pop();
const dir = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function statusLetter(e) {
  if (e.group === "conflicts") return "!";
  if (e.group === "untracked") return "U";
  return e.status;
}
function statusColor(t, e) {
  const s = statusLetter(e);
  return { "!": t.ansi1, U: t.ansi2, A: t.ansi2, M: t.ansi3, D: t.ansi1, R: t.ansi4, C: t.ansi4, T: t.ansi3 }[s] ?? t.muted;
}

// ---------- data ----------

function parseStatus(out) {
  const parts = out.split("\0");
  const branch = { head: "?", upstream: null, ahead: 0, behind: 0, oid: null };
  const groups = { staged: [], changes: [], untracked: [], conflicts: [] };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith("# branch.head ")) branch.head = p.slice(14);
    else if (p.startsWith("# branch.oid ")) branch.oid = p.slice(13);
    else if (p.startsWith("# branch.upstream ")) branch.upstream = p.slice(18);
    else if (p.startsWith("# branch.ab ")) {
      const [a, b] = p.slice(12).split(" ");
      branch.ahead = +a; branch.behind = -b;
    } else if (p.startsWith("1 ") || p.startsWith("2 ")) {
      const f = p.split(" "), xy = f[1];
      const path = f.slice(p[0] === "1" ? 8 : 9).join(" ");
      const orig = p[0] === "2" ? parts[++i] : null;
      if (xy[0] !== ".") groups.staged.push({ group: "staged", path, orig, status: xy[0] });
      if (xy[1] !== ".") groups.changes.push({ group: "changes", path, orig: null, status: xy[1] });
    } else if (p.startsWith("u ")) {
      const f = p.split(" ");
      groups.conflicts.push({ group: "conflicts", path: f.slice(10).join(" "), status: f[1] });
    } else if (p.startsWith("? ")) {
      groups.untracked.push({ group: "untracked", path: p.slice(2), status: "?" });
    }
  }
  return { branch, groups };
}

function sampleRepo() {
  const e = (group, path, status, orig = null) => ({ group, path, status, orig });
  return {
    sample: true, root: "(sample)", on: null,
    branch: { head: "feature/diff-view", upstream: "origin/feature/diff-view", ahead: 2, behind: 1 },
    groups: {
      conflicts: [e("conflicts", "package.json", "UU"), e("conflicts", "src/core/queue.js", "AA")],
      staged: [e("staged", "src/core/repository.js", "M"), e("staged", "src/core/diff.js", "A"), e("staged", "src/ui/row-pair.js", "R", "src/ui/rows.js")],
      changes: [e("changes", "main.js", "M"), e("changes", "docs/old-notes.md", "D"), e("changes", "src/ui/panel/source-control-panel.js", "M")],
      untracked: [e("untracked", "notes/todo.md", "?"), e("untracked", "scratch.txt", "?")],
    },
  };
}

async function loadRepo() {
  const space = spaces().find((s) => s.active);
  if (!space) return { error: "No active space" };
  const on = space.machine ?? null;
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: space.folder || undefined, on });
  if (top.code !== 0) return { error: `Not a Git repository: ${space.folder || "~"}` };
  const root = top.stdout.trim();
  const st = await exec("git", ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], { cwd: root, on });
  if (st.code !== 0) return { error: st.stderr.trim() };
  return { root, on, sample: false, ...parseStatus(st.stdout) };
}

function sampleDiff(d) {
  if (d.status === "D") return ["@@ -1,3 +0,0 @@", "-# Old notes", "-", "-Nothing here any more."];
  if (d.group === "untracked" || d.status === "A") return ["@@ -0,0 +1,4 @@", "+export function loadDiff(target) {", "+  // sample new file", "+  return { rows: [] };", "+}"];
  if (d.group === "conflicts") return ["@@@ -1,5 -1,5 +1,9 @@@", "  {", "++<<<<<<< HEAD", "+   \"version\": \"0.2.0\",", "++=======", "+   \"version\": \"0.3.0-beta\",", "++>>>>>>> feature/x", "  }"];
  return ["@@ -10,7 +10,8 @@ export class Repository {", "   constructor(platform) {", "     this.platform = platform;", "-    this.snapshot = null;", "+    this.snapshot = EMPTY;", "+    this.listeners = new Set();", "   }", "", "   subscribe(fn) {"];
}

async function loadDiff(d) {
  if (d.sample) return sampleDiff(d);
  if (d.group === "untracked") {
    const text = await readTextFile(`${d.root}/${d.path}`, { on: d.on }).catch(() => null);
    if (text == null) return ["(unreadable, binary or too large)"];
    const lines = text.replace(/\n$/, "").split("\n").slice(0, 3000);
    return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => "+" + l)];
  }
  const args = ["--no-optional-locks", "diff", "--no-color", "--no-ext-diff", ...(d.group === "staged" ? ["--cached"] : []), "--", d.path];
  const r = await exec("git", args, { cwd: d.root, on: d.on });
  const all = r.stdout.replace(/\n$/, "").split("\n");
  const first = all.findIndex((l) => l.startsWith("@@"));
  return first < 0 ? ["(no text diff)"] : all.slice(first, first + 3000);
}

const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = +m[1]; next = +m[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, a: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, b: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") return { kind, a: old++, b: next++, text: untab(line.slice(1)) || " " };
    return { kind: "", text: line || " " };
  });
}

// ---------- shared bits ----------

function scrollArea(id, children, t) {
  return div().flex_1().min_h(0).relative()
    .child(v_flex().id(id).absolute().inset_0().overflow_y_scroll().children(children))
    .child(Scrollbar.vertical(id).absolute().inset_0());
}

function button(t, id, label, onClick, opts = {}) {
  const { primary, disabled, small, title } = opts;
  return h_flex().id(id).flex_none().h(small ? 22 : 28).px(small ? 6 : 12).items_center().justify_center().rounded(6)
    .text_size(small ? 11 : 12)
    .bg(disabled ? t.raised : primary ? t.solid : t.raised)
    .text_color(disabled ? t.dim : primary ? t.solid_foreground : t.foreground)
    .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((ev, cx) => { cx.stop_propagation(); onClick(ev, cx); }))
    .child(title ? `${label}` : label);
}

function iconButton(t, id, glyph, onClick, color) {
  return div().id(id).flex_none().w(20).h(20).flex().items_center().justify_center().rounded(4).text_size(13)
    .text_color(color ?? t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click((ev, cx) => { cx.stop_propagation(); onClick(ev, cx); })
    .child(glyph);
}

// ---------- the panel ----------

class Panel {
  constructor(owner, cx) {
    this.owner = owner;
    this.repo = null; this.error = null; this.hover = null; this.selected = null;
    this.collapsed = {}; this.cTab = null; this.composing = false; this.pendingDiscard = null;
    this.message = "";
    this.input = TextareaState.new({ placeholder: "Commit message (Ctrl+Enter to commit)", rows: 3 });
    this.input.on("change", (_e, cx) => { const had = !!this.message.trim(); this.message = this.input.value(); if (had !== !!this.message.trim()) cx.notify(); });
    this.input.on("submit", (_e, cx) => { log("textarea 'submit' event fired"); this.commit(cx); });
    this.refresh(cx);
    if (!checking()) {
      cx.spawn(async (cx) => {
        for (;;) {
          const c = await nextCommand();
          log(`nextCommand → ${JSON.stringify(c)} (type ${typeof c})`);
          if (c === "discard") {
            if (this.pendingDiscard) { this.applyDiscard(this.pendingDiscard); this.pendingDiscard = null; }
            else log("discard arrived with nothing pending");
          }
          cx.notify();
        }
      });
    }
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await loadRepo();
        if (r.error) { this.error = r.error; this.real = null; }
        else { this.error = null; this.real = r; }
      } catch (e) { this.error = String(e); this.real = null; }
      this.repo = null;
      cx.notify();
    });
  }

  data() {
    const p = proto();
    if (!this.repo || this.repo.mode !== p.data) {
      const real = this.real;
      const realHasChanges = real && Object.values(real.groups).some((g) => g.length);
      const useSample = p.data === "sample" || (p.data === "auto" && !realHasChanges) || !real;
      const src = useSample ? sampleRepo() : real;
      // deep copy so stubs can mutate freely
      this.repo = { ...src, mode: p.data, groups: Object.fromEntries(Object.entries(src.groups).map(([k, v]) => [k, v.map((x) => ({ ...x }))])) };
    }
    return this.repo;
  }

  // --- stubbed actions ---
  stage(e) {
    const g = this.repo.groups;
    g[e.group] = g[e.group].filter((x) => x !== e);
    g.staged = g.staged.filter((x) => x.path !== e.path);
    g.staged.push({ ...e, group: "staged", status: e.group === "untracked" ? "A" : e.group === "conflicts" ? "M" : e.status });
    log(`stub stage ${e.path}${e.group === "conflicts" ? " (marks Conflict resolved)" : ""}`);
  }
  unstage(e) {
    const g = this.repo.groups;
    g.staged = g.staged.filter((x) => x !== e);
    if (e.status === "A") g.untracked.push({ ...e, group: "untracked", status: "?" });
    else if (!g.changes.some((x) => x.path === e.path)) g.changes.push({ ...e, group: "changes", orig: null });
    log(`stub unstage ${e.path}`);
  }
  stageAll(key) { [...this.repo.groups[key]].forEach((e) => this.stage(e)); }
  unstageAll() { [...this.repo.groups.staged].forEach((e) => this.unstage(e)); }
  applyDiscard(e) {
    const g = this.repo?.groups;
    if (g) g[e.group] = g[e.group].filter((x) => x.path !== e.path);
    log(`stub discard applied to ${e.path}`);
    notify({ title: "Prototype: discard", body: `Would discard ${e.path}`, level: "info", timeout: 2500 });
  }

  askDiscard(e, cx) {
    const title = e.group === "untracked" ? "Delete untracked file?" : "Discard changes?";
    const detail = e.group === "untracked"
      ? `${e.path} will be deleted. This cannot be undone.`
      : `Your changes to ${e.path} will be lost. This cannot be undone.`;
    if (proto().discard === "confirm") {
      if (this.pendingDiscard) log(`stale pending discard ${this.pendingDiscard.path} replaced (Cancel is invisible to us)`);
      this.pendingDiscard = e;
      log(`confirm mod opened for ${e.path}; args sent: {path, probe:"args?"}`);
      openOverlay({ mod: "confirm", kind: "dialog", modal: true, width: 420, height: 170,
        props: { title, detail, command: { name: `${MOD}.discard`, args: { path: e.path, probe: "args?" } } } });
    } else {
      const req = ++askSeq;
      const answer = new Promise((res) => pendingAsks.set(req, res));
      log(`self overlay req ${req} opened; panel sees map size ${pendingAsks.size}`);
      openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 420, height: 170, props: { view: "ask", req, title, detail } });
      cx.spawn(async (cx) => {
        const ok = await answer;
        log(`self overlay req ${req} answered ${ok}`);
        if (ok) this.applyDiscard(e);
        cx.notify();
      });
    }
  }

  commit(cx) {
    const g = this.repo?.groups;
    if (!g) return;
    const reason = this.commitBlocked();
    if (reason) { log(`commit blocked: ${reason}`); cx?.notify(); return; }
    notify({ title: "Prototype: commit", body: `Would commit ${g.staged.length} file(s): ${this.message.trim().split("\n")[0]}`, level: "success", timeout: 3000 });
    log(`stub commit of ${g.staged.length} file(s)`);
    g.staged = []; this.message = ""; this.input.set_value(""); this.composing = false;
    cx?.notify();
  }
  commitBlocked() {
    const g = this.repo.groups;
    if (g.conflicts.length) return `Resolve ${g.conflicts.length} conflict(s) first`;
    if (!g.staged.length) return "Nothing staged";
    if (!this.message.trim()) return "Enter a commit message";
    return null;
  }

  openDiff(e) {
    const r = this.repo;
    const d = { key: `${e.group}:${e.path}`, path: e.path, orig: e.orig ?? null, group: e.group, status: e.status, root: r.root, on: r.on, sample: r.sample };
    this.selected = d.key;
    const p = proto().placement;
    const space = spaces().find((s) => s.active);
    if (p === "tab") {
      const name = `Δ ${base(d.path)}${d.group === "staged" ? " (staged)" : ""}`;
      const tab = space?.tabs.find((t) => t.name === name);
      if (tab) run("tab.select", { id: tab.id });
      else run("tab.new", { name, mod: MOD, props: { view: "diff", diff: d } });
    } else {
      const cur = shared(DIFFS) ?? { open: [], active: null };
      const open = cur.open.some((o) => o.key === d.key) ? cur.open : [...cur.open, d];
      setShared(DIFFS, { open, active: d.key });
      if (p === "single") {
        const tab = space?.tabs.find((t) => t.name === "Diffs");
        if (tab) run("tab.select", { id: tab.id });
        else run("tab.new", { name: "Diffs", mod: MOD, props: { view: "diff", mode: "single" } });
      } else {
        const f = focused();
        const here = panes().find((x) => x.mod === MOD && x.tab === f?.tab);
        if (!here) run("pane.split", { direction: "right", mod: MOD, props: { view: "diff", mode: "split" } });
      }
    }
    log(`open diff (${p}) ${d.key}`);
  }

  // --- shared row pieces ---
  hoverable(el, key) {
    return el.on_hover((h, cx) => {
      if (h) this.hover = key; else if (this.hover === key) this.hover = null;
      cx.notify();
    });
  }
  rowActions(t, e) {
    const k = `${e.group}:${e.path}`;
    const out = [];
    if (e.group !== "staged" && e.group !== "conflicts") out.push(iconButton(t, `disc-${k}`, "↺", (_v, cx) => this.askDiscard(e, cx)));
    if (e.group === "staged") out.push(iconButton(t, `uns-${k}`, "−", (_v, cx) => { this.unstage(e); cx.notify(); }));
    else out.push(iconButton(t, `stg-${k}`, e.group === "conflicts" ? "✓" : "+", (_v, cx) => { this.stage(e); cx.notify(); }));
    return out;
  }

  // --- variant A: classic, commit box on top, collapsible groups, hover actions ---
  renderA(t, r) {
    const b = r.branch;
    const blocked = this.commitBlocked();
    const header = v_flex().flex_none().px(12).pt(10).pb(8).gap(2)
      .child(h_flex().items_center().gap(6)
        .child(div().text_color(t.muted).child("⎇"))
        .child(div().font_semibold().truncate().child(b.head === "(detached)" ? `Detached at ${b.oid?.slice(0, 7) ?? "?"}` : b.head))
        .child(div().flex_1())
        .child(iconButton(t, "refresh", "↻", (_v, cx) => this.refresh(cx))))
      .child(div().text_size(11).text_color(t.dim).child(b.upstream ? `${b.upstream}   ↑${b.ahead}  ↓${b.behind}` : "No upstream branch"));
    const commitBox = v_flex().flex_none().px(10).pb(10).gap(6).border_b(1).border_color(t.border)
      .child(this.commitInput(t))
      .child(h_flex().gap(8).items_center()
        .child(button(t, "commit", `Commit${r.groups.staged.length ? ` (${r.groups.staged.length})` : ""}`, (_v, cx) => this.commit(cx), { primary: true, disabled: !!blocked }))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(r.groups.conflicts.length ? t.ansi1 : t.dim).child(blocked ?? "")));
    const sections = [];
    for (const [key, label] of GROUPS) {
      const items = r.groups[key];
      if (!items.length) continue;
      const open = !this.collapsed[key];
      const gk = `g-${key}`;
      sections.push(this.hoverable(h_flex().id(gk).h(26).flex_none().px(8).gap(4).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.collapsed[key] = open; cx.notify(); })
        .child(div().w(12).text_size(10).text_color(t.dim).child(open ? "▾" : "▸"))
        .child(div().text_size(11).font_semibold().text_color(key === "conflicts" ? t.ansi1 : t.muted).child(label.toUpperCase()))
        .child(div().flex_1())
        .when(this.hover === gk && key !== "staged", (e) => e.child(iconButton(t, `${gk}-all`, "+", (_v, cx) => { this.stageAll(key); cx.notify(); })))
        .when(this.hover === gk && key === "staged", (e) => e.child(iconButton(t, `${gk}-all`, "−", (_v, cx) => { this.unstageAll(); cx.notify(); })))
        .child(div().px(6).rounded(8).bg(t.raised).text_size(10).text_color(t.muted).child(String(items.length))), gk));
      if (open) for (const e of items) {
        const k = `${e.group}:${e.path}`;
        sections.push(this.hoverable(h_flex().id(`row-${k}`).h(24).flex_none().pl(24).pr(8).gap(6).items_center().cursor_pointer()
          .when(this.selected === k, (x) => x.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_v, cx) => { this.openDiff(e); cx.notify(); })
          .child(div().flex_none().max_w(200).truncate().text_color(e.status === "D" ? t.muted : t.foreground).child(base(e.path)))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(e.orig ? `${dir(e.path)} ← ${base(e.orig)}` : dir(e.path)))
          .when(this.hover === k, (x) => x.children(this.rowActions(t, e)))
          .child(div().w(14).flex_none().text_size(11).font_semibold().text_color(statusColor(t, e)).child(statusLetter(e))), k));
      }
    }
    if (!sections.length) sections.push(div().p(12).text_color(t.dim).child("No changes"));
    return v_flex().flex_1().min_h(0).child(header).child(commitBox).child(scrollArea("a-list", sections, t));
  }

  // --- variant B: two stacked lists (unstaged above, staged below), checkboxes, commit at bottom ---
  renderB(t, r) {
    const b = r.branch;
    const blocked = this.commitBlocked();
    const top = h_flex().flex_none().h(34).px(10).gap(6).items_center().border_b(1).border_color(t.border).text_size(12)
      .child(div().font_semibold().truncate().child(b.head))
      .child(div().text_color(t.dim).child(b.upstream ? "→" : ""))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(b.upstream ?? "no upstream"))
      .when(!!b.upstream, (e) => e.child(div().text_size(11).px(6).rounded(8).bg(t.raised).child(`↑${b.ahead} ↓${b.behind}`)))
      .child(iconButton(t, "refresh", "↻", (_v, cx) => this.refresh(cx)));
    const row = (e) => {
      const k = `${e.group}:${e.path}`, staged = e.group === "staged";
      return this.hoverable(h_flex().id(`row-${k}`).h(26).flex_none().px(8).gap(8).items_center().cursor_pointer()
        .when(this.selected === k, (x) => x.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_v, cx) => { this.openDiff(e); cx.notify(); })
        .child(div().id(`chk-${k}`).flex_none().w(14).h(14).rounded(3).border_1().border_color(staged ? t.accent : t.input).bg(staged ? t.accent : t.background)
          .flex().items_center().justify_center().text_size(10).text_color(t.accent_foreground).cursor_pointer()
          .on_click((_v, cx) => { cx.stop_propagation(); staged ? this.unstage(e) : this.stage(e); cx.notify(); })
          .child(staged ? "✓" : ""))
        .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(statusColor(t, e)).child(statusLetter(e)))
        .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(dir(e.path) ? dir(e.path) + "/" : "")).child(div().flex_none().child(base(e.path))))
        .when(this.hover === k && !staged && e.group !== "conflicts", (x) => x.child(iconButton(t, `disc-${k}`, "🗑", (_v, cx) => this.askDiscard(e, cx), t.ansi1))), k);
    };
    const unstaged = [...r.groups.conflicts, ...r.groups.changes, ...r.groups.untracked];
    const sectionHead = (label, count, action) => h_flex().flex_none().h(28).px(10).gap(6).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(`${label}  ${count}`)).child(div().flex_1()).child(action);
    const conflictBanner = r.groups.conflicts.length
      ? div().flex_none().px(10).py(6).text_size(11).bg(t.ansi1 + "22").text_color(t.ansi1).child(`${r.groups.conflicts.length} conflict(s): fix them in your editor, then tick to mark resolved`)
      : null;
    return v_flex().flex_1().min_h(0).child(top)
      .child(sectionHead("Unstaged", unstaged.length, button(t, "stage-all", "Stage all", (_v, cx) => { ["conflicts", "changes", "untracked"].forEach((k) => this.stageAll(k)); cx.notify(); }, { small: true, disabled: !unstaged.length })))
      .when(!!conflictBanner, (e) => e.child(conflictBanner))
      .child(scrollArea("b-unstaged", unstaged.length ? unstaged.map(row) : [div().p(10).text_color(t.dim).child("Nothing to stage")], t))
      .child(sectionHead("Staged", r.groups.staged.length, button(t, "unstage-all", "Unstage all", (_v, cx) => { this.unstageAll(); cx.notify(); }, { small: true, disabled: !r.groups.staged.length })))
      .child(scrollArea("b-staged", r.groups.staged.length ? r.groups.staged.map(row) : [div().p(10).text_color(t.dim).child("Tick files to stage them")], t))
      .child(v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
        .child(this.commitInput(t))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(r.groups.conflicts.length ? t.ansi1 : t.dim).child(blocked ?? `${r.groups.staged.length} file(s) ready`))
          .child(button(t, "commit", `Commit to ${b.head}`, (_v, cx) => this.commit(cx), { primary: true, disabled: !!blocked }))));
  }

  // --- variant C: branch card, one group at a time via segmented tabs, action bar for the selection, collapsible commit composer ---
  renderC(t, r) {
    const b = r.branch;
    const nonEmpty = GROUPS.filter(([k]) => r.groups[k].length);
    if (!this.cTab || !r.groups[this.cTab]?.length) this.cTab = nonEmpty[0]?.[0] ?? "changes";
    const items = r.groups[this.cTab];
    const sel = items.find((e) => `${e.group}:${e.path}` === this.selected) ?? null;
    const card = v_flex().flex_none().m(10).p(10).gap(4).rounded(8).bg(t.raised)
      .child(h_flex().items_center().gap(6)
        .child(div().text_size(15).font_semibold().truncate().child(b.head))
        .child(div().flex_1())
        .child(iconButton(t, "refresh", "↻", (_v, cx) => this.refresh(cx))))
      .child(h_flex().gap(6).items_center().text_size(11)
        .child(div().text_color(t.dim).truncate().child(b.upstream ?? "No upstream"))
        .when(b.ahead > 0, (e) => e.child(div().px(6).rounded(8).bg(t.ansi2 + "33").text_color(t.ansi2).child(`${b.ahead} to push`)))
        .when(b.behind > 0, (e) => e.child(div().px(6).rounded(8).bg(t.ansi3 + "33").text_color(t.ansi3).child(`${b.behind} to pull`))));
    const tabs = h_flex().flex_none().mx(10).p(2).gap(2).rounded(8).bg(t.chrome)
      .children(GROUPS.map(([k, label]) => {
        const n = r.groups[k].length, on = this.cTab === k;
        return div().id(`tab-${k}`).flex_1().h(26).flex().items_center().justify_center().rounded(6).text_size(11)
          .when(on, (e) => e.bg(t.background).font_semibold())
          .text_color(n ? (k === "conflicts" ? t.ansi1 : on ? t.foreground : t.muted) : t.dim)
          .when(n > 0, (e) => e.cursor_pointer().on_click((_v, cx) => { this.cTab = k; this.selected = null; cx.notify(); }))
          .child(`${label} ${n}`);
      }));
    const rows = items.map((e) => {
      const k = `${e.group}:${e.path}`;
      return h_flex().id(`row-${k}`).h(30).flex_none().mx(6).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .when(this.selected === k, (x) => x.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((ev, cx) => { this.selected = k; if (ev.click_count >= 2) this.openDiff(e); cx.notify(); })
        .child(div().w(18).h(18).flex_none().rounded(4).bg(statusColor(t, e) + "33").flex().items_center().justify_center().text_size(10).font_semibold().text_color(statusColor(t, e)).child(statusLetter(e)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().child(base(e.path)))
          .when(!!dir(e.path) || !!e.orig, (x) => x.child(div().truncate().text_size(10).text_color(t.dim).child(e.orig ? `renamed from ${e.orig}` : dir(e.path)))));
    });
    const actionBar = h_flex().flex_none().px(10).py(8).gap(6).border_t(1).border_color(t.border).items_center()
      .when(!sel, (e) => e.child(div().flex_1().text_size(11).text_color(t.dim).child("Select a file · double-click opens its diff"))
        .child(button(t, "group-all", this.cTab === "staged" ? "Unstage all" : "Stage all", (_v, cx) => { this.cTab === "staged" ? this.unstageAll() : this.stageAll(this.cTab); cx.notify(); }, { small: true, disabled: !items.length })))
      .when(!!sel, (e) => e
        .child(button(t, "act-open", "Open diff", () => this.openDiff(sel), { small: true }))
        .child(sel?.group === "staged"
          ? button(t, "act-unstage", "Unstage", (_v, cx) => { this.unstage(sel); this.selected = null; cx.notify(); }, { small: true })
          : button(t, "act-stage", sel?.group === "conflicts" ? "Mark resolved" : "Stage", (_v, cx) => { this.stage(sel); this.selected = null; cx.notify(); }, { small: true }))
        .child(div().flex_1())
        .when(sel?.group === "changes" || sel?.group === "untracked", (x) => x.child(button(t, "act-discard", "Discard…", (_v, cx) => this.askDiscard(sel, cx), { small: true }))));
    const blocked = this.commitBlocked();
    const composer = this.composing
      ? v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border).bg(t.chrome)
        .child(this.commitInput(t))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(r.groups.conflicts.length ? t.ansi1 : t.dim).child(blocked ?? ""))
          .child(button(t, "c-cancel", "Cancel", (_v, cx) => { this.composing = false; cx.notify(); }, { small: true }))
          .child(button(t, "commit", "Commit", (_v, cx) => this.commit(cx), { primary: true, small: true, disabled: !!blocked })))
      : h_flex().id("compose").flex_none().h(38).px(12).gap(6).items_center().border_t(1).border_color(t.border).bg(t.chrome).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_v, cx) => { this.composing = true; this.input.focus(); cx.notify(); })
        .child(div().text_color(t.muted).child("✎"))
        .child(div().flex_1().text_color(r.groups.staged.length ? t.foreground : t.dim).child(r.groups.staged.length ? `Commit ${r.groups.staged.length} staged file(s)…` : "Nothing staged"));
    return v_flex().flex_1().min_h(0).child(card).child(tabs).child(div().h(6).flex_none())
      .child(scrollArea("c-list", rows.length ? rows : [div().p(12).text_color(t.dim).child("Nothing here")], t))
      .child(actionBar).child(composer);
  }

  commitInput(t) {
    return div().id("commit-box").w_full().px(8).py(6).rounded(6).border_1().border_color(t.input).bg(t.background)
      .on_key_down((e, cx) => {
        if (e.keystroke === "ctrl-enter" || e.keystroke === "cmd-enter") { log(`commit via on_key_down ${e.keystroke}`); this.commit(cx); cx.stop_propagation(); }
      })
      .child(Textarea.new(this.input).w_full().text_size(12).text_color(t.foreground));
  }

  protoBar(t) {
    const p = proto();
    const chip = (id, label, onClick) => div().id(id).px(8).h(22).flex().items_center().rounded(11).bg(t.accent).text_color(t.accent_foreground).text_size(11).cursor_pointer().hover((s) => s.opacity(0.85))
      .on_click((_v, cx) => { onClick(); cx.notify(); }).child(label);
    const names = { A: "A classic", B: "B two lists", C: "C one group" };
    return v_flex().flex_none().border_t(2).border_color(t.accent).bg(t.canvas)
      .when(p.log, (e) => e.child(v_flex().px(8).py(4).max_h(150).overflow_hidden().text_size(10).font_family(settings().font_family ?? "monospace").text_color(t.muted)
        .children(moduleLog.length ? moduleLog.map((l) => div().truncate().child(l)) : [div().child("(log empty)")])))
      .child(h_flex().flex_wrap().gap(4).p(6).items_center()
        .child(div().text_size(10).font_semibold().text_color(t.accent).child("PROTOTYPE"))
        .child(chip("p-panel", `Panel ${names[p.panel]} ▸`, () => setProto({ panel: cycle(["A", "B", "C"], p.panel) })))
        .child(chip("p-place", `Diffs: ${p.placement} ▸`, () => setProto({ placement: cycle(["tab", "single", "split"], p.placement) })))
        .child(chip("p-disc", `Discard: ${p.discard} ▸`, () => setProto({ discard: cycle(["confirm", "self"], p.discard) })))
        .child(chip("p-data", `Data: ${p.data} ▸`, () => setProto({ data: cycle(["auto", "real", "sample"], p.data) })))
        .child(chip("p-log", p.log ? "Hide log" : "Log", () => setProto({ log: !p.log }))));
  }

  render(cx) {
    const t = theme(), p = proto();
    let body;
    if (!this.real && !this.error && p.data !== "sample") body = div().p(12).text_color(t.dim).child("Loading…");
    else {
      const r = this.data();
      if (p.data === "real" && !this.real) body = div().p(12).text_color(t.ansi1).child(this.error ?? "No repository");
      else body = p.panel === "B" ? this.renderB(t, r) : p.panel === "C" ? this.renderC(t, r) : this.renderA(t, r);
      if (r.sample && p.data !== "sample") body = v_flex().flex_1().min_h(0).child(div().flex_none().px(10).py(3).text_size(10).bg(t.raised).text_color(t.dim).child(this.error ? `Sample data (${this.error})` : "Sample data: the repository is clean")).child(body);
    }
    return v_flex().id("panel").size_full().min_h(0).bg(t.chrome).text_size(13).text_color(t.foreground).child(body).child(this.protoBar(t));
  }
}

// ---------- the Diff view (tab per file, single Diffs tab, or split pane) ----------

class DiffPane {
  constructor(owner, cx) { this.owner = owner; this.loadedKey = null; this.rows = []; this.loading = false; }

  current() {
    const p = props() ?? {};
    if (p.diff) return { d: p.diff, open: null, active: p.diff.key };
    const s = shared(DIFFS) ?? { open: [], active: null };
    return { d: s.open.find((o) => o.key === s.active) ?? null, open: s.open, active: s.active };
  }

  ensure(d, cx) {
    if (!d || this.loadedKey === d.key || this.loading === d.key) return;
    this.loading = d.key;
    cx.spawn(async (cx) => {
      let lines;
      try { lines = await loadDiff(d); } catch (e) { lines = [`(failed: ${e})`]; }
      if (this.loading === d.key) { this.rows = diffRows(lines); this.loadedKey = d.key; this.loading = false; }
      cx.notify();
    });
  }

  render(cx) {
    const t = theme(), p = props() ?? {};
    const { d, open, active } = this.current();
    this.ensure(d, cx);
    const switcher = open && open.length
      ? h_flex().flex_none().h(30).px(4).gap(2).items_center().bg(t.chrome).border_b(1).border_color(t.border).overflow_x_hidden()
        .children(open.map((o) => h_flex().id(`sw-${o.key}`).flex_none().h(24).pl(8).pr(2).gap(4).items_center().rounded(5).text_size(11).cursor_pointer()
          .when(o.key === active, (e) => e.bg(t.background).text_color(t.foreground)).when(o.key !== active, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover)))
          .on_click((_v, cx) => { setShared(DIFFS, { open, active: o.key }); cx.notify(); })
          .child(`${base(o.path)}${o.group === "staged" ? " ●" : ""}`)
          .child(iconButton(t, `swx-${o.key}`, "×", () => {
            const rest = open.filter((x) => x.key !== o.key);
            setShared(DIFFS, { open: rest, active: o.key === active ? rest[rest.length - 1]?.key ?? null : active });
          }))))
      : null;
    if (!d) {
      return v_flex().size_full().bg(t.background).text_color(t.dim).text_size(13)
        .when(!!switcher, (e) => e.child(switcher))
        .child(div().p(16).child(`No diff open (${p.mode ?? "tab"} placement). Click a file in the Source Control panel.`));
    }
    const badge = (text, color) => div().px(6).rounded(4).text_size(10).bg(color + "33").text_color(color).child(text);
    const groupColor = { staged: t.ansi2, changes: t.ansi3, untracked: t.ansi2, conflicts: t.ansi1 }[d.group];
    const header = h_flex().flex_none().h(36).px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.surface)
      .child(div().font_semibold().truncate().child(d.orig ? `${d.orig} → ${d.path}` : d.path))
      .child(badge({ staged: "Staged", changes: "Unstaged", untracked: "Untracked", conflicts: "Conflict" }[d.group], groupColor))
      .child(badge(d.group === "conflicts" ? d.status : statusLetter(d), statusColor(t, d)))
      .child(div().flex_1())
      .child(div().text_size(10).text_color(t.dim).child(`placement: ${p.mode ?? "tab"}${d.sample ? " · sample" : ""}`));
    const body = this.loadedKey === d.key
      ? scrollArea(`diff-${p.mode ?? "tab"}`, this.rows.map((r, i) => r.kind === "@"
        ? div().h(20).flex_none().px(12).bg(t.raised).text_color(t.dim).truncate().child(r.text)
        : h_flex().h(20).flex_none().gap(8)
          .when(r.kind === "+", (e) => e.bg(t.ansi2 + "18")).when(r.kind === "-", (e) => e.bg(t.ansi1 + "18"))
          .child(div().w(36).flex_none().text_right().text_color(t.dim).child(r.a === undefined ? "" : String(r.a)))
          .child(div().w(36).flex_none().text_right().text_color(t.dim).child(r.b === undefined ? "" : String(r.b)))
          .child(div().flex_1().min_w(0).truncate().child(r.text))), t)
      : div().p(16).text_color(t.dim).child("Loading diff…");
    return v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12)
      .when(!!switcher, (e) => e.child(switcher))
      .child(header)
      .child(div().flex_1().min_h(0).flex().flex_col().font_family(settings().font_family ?? "monospace").text_size(11).child(body));
  }
}

// ---------- the self-overlay confirm (fallback probe) ----------

class AskDialog {
  constructor(owner, cx) {
    this.handle = cx.focus_handle(); this.handle.focus();
    const req = props()?.req;
    log(`ask overlay copy started: sees map size ${pendingAsks.size}, req ${req} ${pendingAsks.has(req) ? "FOUND" : "MISSING"}`);
  }
  answer(v) {
    const p = props(), res = pendingAsks.get(p.req);
    if (res) { pendingAsks.delete(p.req); res(v); } else log(`ask overlay: req ${p.req} missing from module map`);
    closeOverlay(p.overlay);
  }
  close() {
    const req = props()?.req;
    if (pendingAsks.has(req)) { log(`ask overlay closed without answer (Esc): resolving false`); this.answer(false); }
  }
  render(cx) {
    const t = theme(), p = props() ?? {};
    return v_flex().id("ask").track_focus(this.handle).size_full().p(18).gap(12).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => { if (e.key === "enter") { this.answer(true); cx.stop_propagation(); } })
      .child(div().text_size(15).font_semibold().child(p.title ?? "Sure?"))
      .child(div().flex_1().text_color(t.muted).child(p.detail ?? ""))
      .child(h_flex().justify_end().gap(8)
        .child(button(t, "no", "Cancel", () => this.answer(false)))
        .child(button(t, "yes", "Discard", () => this.answer(true), { primary: true })));
  }
}

const KINDS = { panel: Panel, diff: DiffPane, ask: AskDialog };

export default class GitWorkbenchPrototype extends View {
  init(_props, cx) {
    const view = props()?.view ?? "panel";
    this.copy = ++copySeq;
    this.impl = new (KINDS[view] ?? Panel)(this, cx);
    log(`copy #${this.copy} started as ${view}${props()?.mode ? ` (${props().mode})` : ""}`);
  }
  async close(cx) { this.impl.close?.(cx); }
  render(cx) { return this.impl.render(cx); }
}
