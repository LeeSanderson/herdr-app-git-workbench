// @ts-check
// The Source Control panel: follows the active space and shows the Workbench state.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, home, theme, run, checking, nextCommand } from "herdr";
import { statusLetter, statusColor, printable, folderOf, nameOf, scrollArea } from "./theme.js";

/** @typedef {ReturnType<import("../core/workbench.js").createWorkbench>} Workbench */

/** The layout block id the install steps give the panel's column. */
const LAYOUT_ID = "git-workbench";

/**
 * Resolves at the next Workbench state change or followed-Repository snapshot change.
 * @param {Workbench} workbench
 * @returns {Promise<void>}
 */
function nextChange(workbench) {
  return new Promise((resolve) => {
    /** @type {(() => void)[]} */
    const offs = [];
    const done = () => {
      for (const off of offs) off();
      resolve();
    };
    offs.push(workbench.subscribe(done));
    const s = workbench.state;
    if (s.kind === "ready") offs.push(s.repository.subscribe(done));
  });
}

/** Where the active space lives: its machine and folder ("" = that machine's home). */
function activeSpace() {
  const space = spaces().find((s) => s.active);
  if (!space) return null;
  const machine = space.machine ?? null;
  return { machine, folder: space.folder || (machine == null ? home() : "") };
}

export class SourceControlPanel {
  /** @param {Workbench} workbench @param {import("gpui-kit").Context} cx */
  constructor(workbench, cx) {
    this.workbench = workbench;
    /** @type {string | null} */
    this.following = null;
    /** @type {string | null} */
    this.error = null;
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      for (;;) {
        await nextChange(workbench);
        cx.notify();
      }
    });
    if (!checking()) {
      cx.spawn(async (cx) => {
        for (;;) {
          const command = await nextCommand();
          if (command === "focus") this.handle.focus();
          cx.notify();
        }
      });
    }
  }

  /** Follows the active space when it changes. Render re-runs when spaces change. */
  follow() {
    if (checking()) return;
    const where = activeSpace();
    if (!where) return;
    const key = JSON.stringify(where);
    if (key === this.following) return;
    this.following = key;
    this.error = null;
    this.workbench.follow(where).catch((err) => {
      this.error = String(err?.message ?? err);
    });
  }

  /** @param {import("gpui-kit").Context} _cx */
  render(_cx) {
    this.follow();
    const t = theme();
    const state = this.workbench.state;
    return v_flex()
      .size_full()
      .track_focus(this.handle)
      .bg(t.surface)
      .text_color(t.foreground)
      .text_size(13)
      .child(this.topBar(t, state))
      .child(this.body(t, state));
  }

  /** @param {Record<string, string>} t @param {any} state */
  topBar(t, state) {
    const bar = h_flex().flex_none().h(34).px(10).gap(8).items_center().border_b_1().border_color(t.border);
    if (state.kind === "ready" && state.repository.snapshot) {
      const s = state.repository.snapshot;
      bar.child(div().flex_none().text_color(t.muted).child("⎇"));
      bar.child(div().min_w(0).truncate().font_weight(600).child(s.branch ?? "(detached HEAD)"));
      if (s.unborn) bar.child(div().flex_none().text_size(11).text_color(t.dim).child("no commits yet"));
    } else {
      bar.child(div().min_w(0).truncate().text_color(t.muted).child("Source Control"));
    }
    return bar
      .child(div().flex_1())
      .child(
        div().id("close").flex_none().w(22).h(22).flex().items_center().justify_center().rounded(4)
          .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            run("layout.hide", { id: LAYOUT_ID });
          })
          .child("✕"),
      );
  }

  /** @param {Record<string, string>} t @param {any} state */
  body(t, state) {
    if (this.error) return screen(t, "Something went wrong", this.error);
    switch (state.kind) {
      case "git-missing":
        return screen(t, "Git not found",
          "Git isn't on PATH or in its standard install folders. Install Git for Windows (git-scm.com), then switch space or reload to try again.");
      case "no-repository":
        return screen(t, "No repository", `${state.folder || "This folder"} is not inside a Git repository.`);
      case "loading":
        return screen(t, "Loading…", "");
      case "ready":
        if (!state.repository.snapshot) return screen(t, "Couldn't read the repository", state.repository.key.toplevel);
        return changeLists(t, state.repository.snapshot.groups);
      default:
        return div();
    }
  }
}

/**
 * The two stacked lists: Unstaged (Conflicts, Changes, Untracked) above, Staged below.
 * @param {Record<string, string>} t @param {import("../core/status.js").ChangeGroups} groups
 */
function changeLists(t, groups) {
  const unstaged = [...groups.conflicts, ...groups.changes, ...groups.untracked];
  return v_flex().flex_1().min_h(0)
    .child(listHeader(t, "Unstaged", unstaged.length))
    .child(scrollArea("unstaged", unstaged.length ? unstaged.map((c) => changeRow(t, c)) : [emptyNote(t, "No changes")]))
    .child(listHeader(t, "Staged", groups.staged.length))
    .child(scrollArea("staged", groups.staged.length ? groups.staged.map((c) => changeRow(t, c)) : [emptyNote(t, "Nothing staged")]));
}

/** @param {Record<string, string>} t @param {string} label @param {number} count */
function listHeader(t, label, count) {
  return h_flex().flex_none().h(28).px(10).gap(6).items_center().bg(t.chrome).border_b_1().border_color(t.border)
    .child(div().text_size(11).font_semibold().text_color(t.muted).child(`${label} ${count}`));
}

/** @param {Record<string, string>} t @param {string} text */
function emptyNote(t, text) {
  return div().p(10).text_size(12).text_color(t.dim).child(text);
}

/**
 * One Change: a coloured status letter, the dim folder, the bold file name and, for a rename, its old path.
 * @param {Record<string, string>} t @param {import("../core/status.js").Change} change
 */
function changeRow(t, change) {
  const path = printable(change.path);
  const row = h_flex().id(`row-${change.group}:${change.path}`).flex_none().h(24).px(10).gap(8).items_center()
    .hover((s) => s.bg(t.hover))
    .child(div().flex_none().w(12).text_size(11).font_semibold().text_color(statusColor(t, change)).child(statusLetter(change)))
    .child(h_flex().flex_1().min_w(0)
      .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.dim).child(folderOf(path)))
      .child(div().flex_none().font_semibold().child(nameOf(path))));
  if (change.oldPath !== undefined) {
    row.child(div().flex_shrink(1).min_w(0).max_w(160).truncate().text_size(11).text_color(t.dim).child(`← ${printable(change.oldPath)}`));
  }
  return row;
}

/** A centred title and explanation for a state with nothing to list. */
function screen(t, title, detail) {
  return v_flex().flex_1().min_h(0).items_center().justify_center().gap(6).p(16)
    .child(div().font_weight(600).child(title))
    .child(div().text_size(12).text_color(t.muted).text_center().child(detail));
}
