// @ts-check
// The Source Control panel: follows the active space and shows the Workbench state.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, home, theme, run, checking, nextCommand, openOverlay } from "herdr";
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
    /** The lastError whose detail toggle is shown, and whether its detail is open. */
    this.shownError = null;
    this.showDetail = false;
    /** The row the pointer is over (its id), which shows its 🗑. @type {string | null} */
    this.hoveredRow = null;
    /**
     * The Change the confirm dialog asks about, and the snapshot it was taken from.
     * Valid only for the next "discard", and only while that snapshot is current.
     * @type {{ repositoryId: string, snapshot: any, change: import("../core/status.js").Change } | null}
     */
    this.pendingDiscard = null;
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
          else if (command === "discard") this.confirmDiscard();
          cx.notify();
        }
      });
    }
  }

  /**
   * Asks before discarding `change`: remembers it, then opens the shipped confirm
   * dialog, whose Confirm runs our "discard" command. Cancel is invisible to us.
   * @param {any} repository @param {import("../core/status.js").Change} change
   */
  askDiscard(repository, change) {
    this.pendingDiscard = { repositoryId: repository.id, snapshot: repository.snapshot, change };
    openOverlay({
      mod: "confirm", kind: "dialog", modal: true, width: 420, height: 170,
      props: {
        title: "Discard changes?",
        detail: `${printable(change.path)} will be restored. This cannot be undone.`,
        command: { name: "herdr-app-git-workbench.discard" },
      },
    });
  }

  /**
   * The "discard" command: discards the pending Change if it is still valid, that is,
   * the same Repository has not refreshed since the dialog opened and the Change is
   * still listed. The pending Change is used up either way.
   */
  confirmDiscard() {
    const pending = this.pendingDiscard;
    this.pendingDiscard = null;
    if (!pending) return;
    const state = this.workbench.state;
    if (state.kind !== "ready" || state.repository.id !== pending.repositoryId) return;
    const s = state.repository.snapshot;
    if (s !== pending.snapshot) return;
    const { group, path } = pending.change;
    const listed = s.groups[group]?.some((c) => c.path === path);
    if (listed && (group === "changes" || group === "untracked")) void state.repository.discard([path]);
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
      case "ready": {
        const { repository } = state;
        const s = repository.snapshot;
        if (!s) return screen(t, "Couldn't read the repository", repository.key.toplevel);
        /** @type {Actions} */
        const actions = {
          busy: s.running !== null,
          // Nothing is staged except what the user ticks. Results land in snapshot.lastError.
          stage: (changes) => void repository.stage(changes.map((c) => c.path)),
          unstage: (changes) => void repository.unstage(changes.flatMap(pathsOf)),
          discard: (change) => this.askDiscard(repository, change),
          hoveredRow: this.hoveredRow,
          hover: (rowId, hovered) => {
            if (hovered) this.hoveredRow = rowId;
            else if (this.hoveredRow === rowId) this.hoveredRow = null;
          },
        };
        return v_flex().flex_1().min_h(0)
          .when(s.running !== null, (e) => e.child(runningStrip(t, s.running.label)))
          .when(s.lastError !== null, (e) => e.child(this.errorStrip(t, s.lastError)))
          .child(changeLists(t, s.groups, actions));
      }
      default:
        return div();
    }
  }

  /**
   * The last action's failure: its summary, and the full detail on demand.
   * @param {Record<string, string>} t @param {{ summary: string, detail: string }} error
   */
  errorStrip(t, error) {
    if (this.shownError !== error) {
      this.shownError = error;
      this.showDetail = false;
    }
    const strip = v_flex().id("last-error").flex_none().px(10).py(6).gap(4).text_size(11)
      .bg(t.ansi1 + "22").text_color(t.ansi1).border_b_1().border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().child(error.summary))
        .when(error.detail !== error.summary, (e) => e.child(
          div().id("error-detail-toggle").flex_none().cursor_pointer().text_color(t.muted)
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.showDetail = !this.showDetail;
              cx.notify();
            })
            .child(this.showDetail ? "Hide details" : "Details"))));
    if (this.showDetail) {
      strip.child(div().id("error-detail").max_h(160).overflow_y_scroll().text_color(t.foreground)
        .children(error.detail.split("\n").map((line) => div().child(line || " "))));
    }
    return strip;
  }
}

/**
 * @typedef {{
 *   busy: boolean,
 *   stage(changes: import("../core/status.js").Change[]): void,
 *   unstage(changes: import("../core/status.js").Change[]): void,
 *   discard(change: import("../core/status.js").Change): void,
 *   hoveredRow: string | null,
 *   hover(rowId: string, hovered: boolean): void,
 * }} Actions
 */

/** The paths to unstage for a staged Change: both sides of a rename. @param {import("../core/status.js").Change} c */
const pathsOf = (c) => (c.oldPath !== undefined ? [c.path, c.oldPath] : [c.path]);

/** The running command's label ("Staging…"); actions are disabled meanwhile. @param {Record<string, string>} t @param {string} label */
function runningStrip(t, label) {
  return h_flex().flex_none().h(24).px(10).items_center().text_size(11).text_color(t.muted)
    .bg(t.chrome).border_b_1().border_color(t.border)
    .child(label);
}

/**
 * The two stacked lists: Unstaged (Conflicts, Changes, Untracked) above, Staged below.
 * @param {Record<string, string>} t @param {import("../core/status.js").ChangeGroups} groups @param {Actions} actions
 */
function changeLists(t, groups, actions) {
  const unstaged = [...groups.conflicts, ...groups.changes, ...groups.untracked];
  const row = (c) => changeRow(t, c, actions);
  return v_flex().flex_1().min_h(0)
    .child(listHeader(t, "Unstaged", unstaged.length,
      button(t, "stage-all", "Stage all", () => actions.stage(unstaged), actions.busy || !unstaged.length)))
    .child(scrollArea("unstaged", unstaged.length ? unstaged.map(row) : [emptyNote(t, "No changes")]))
    .child(listHeader(t, "Staged", groups.staged.length,
      button(t, "unstage-all", "Unstage all", () => actions.unstage(groups.staged), actions.busy || !groups.staged.length)))
    .child(scrollArea("staged", groups.staged.length ? groups.staged.map(row) : [emptyNote(t, "Nothing staged")]));
}

/** @param {Record<string, string>} t @param {string} label @param {number} count @param {any} action */
function listHeader(t, label, count, action) {
  return h_flex().flex_none().h(28).px(10).gap(6).items_center().bg(t.chrome).border_b_1().border_color(t.border)
    .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child(`${label} ${count}`))
    .child(action);
}

/**
 * A small header button, inert while disabled.
 * @param {Record<string, string>} t @param {string} id @param {string} label @param {() => void} onClick @param {boolean} disabled
 */
function button(t, id, label, onClick, disabled) {
  return h_flex().id(id).flex_none().h(20).px(6).items_center().justify_center().rounded(4).text_size(11)
    .bg(t.raised).text_color(disabled ? t.dim : t.foreground)
    .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick();
      }))
    .child(label);
}

/**
 * The row's checkbox: ticked when staged. Ticking stages (or marks a Conflict resolved),
 * unticking unstages.
 * @param {Record<string, string>} t @param {import("../core/status.js").Change} change @param {Actions} actions
 */
function checkbox(t, change, actions) {
  const staged = change.group === "staged";
  return div().id(`chk-${change.group}:${change.path}`).flex_none().w(14).h(14).rounded(3).border_1()
    .border_color(staged ? t.accent : t.input).bg(staged ? t.accent : t.background)
    .flex().items_center().justify_center().text_size(10).text_color(t.accent_foreground)
    .when(actions.busy, (e) => e.opacity(0.5))
    .when(!actions.busy, (e) => e.cursor_pointer().on_click((_e, cx) => {
      cx.stop_propagation();
      if (staged) actions.unstage([change]);
      else actions.stage([change]);
    }))
    .child(staged ? "✓" : "");
}

/** @param {Record<string, string>} t @param {string} text */
function emptyNote(t, text) {
  return div().p(10).text_size(12).text_color(t.dim).child(text);
}

/**
 * One Change: a coloured status letter, the dim folder, the bold file name and, for a rename, its old path.
 * @param {Record<string, string>} t @param {import("../core/status.js").Change} change @param {Actions} actions
 */
function changeRow(t, change, actions) {
  const path = printable(change.path);
  const rowId = `row-${change.group}:${change.path}`;
  // Discard is offered only for unstaged edits and untracked files, never staged rows or Conflicts.
  const discardable = change.group === "changes" || change.group === "untracked";
  const row = h_flex().id(rowId).flex_none().h(24).px(10).gap(8).items_center()
    .hover((s) => s.bg(t.hover))
    .when(discardable, (e) => e.on_hover((hovered, cx) => {
      actions.hover(rowId, hovered);
      cx.notify();
    }))
    .child(checkbox(t, change, actions))
    .child(div().flex_none().w(12).text_size(11).font_semibold().text_color(statusColor(t, change)).child(statusLetter(change)))
    .child(h_flex().flex_1().min_w(0)
      .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.dim).child(folderOf(path)))
      .child(div().flex_none().font_semibold().child(nameOf(path))));
  if (change.oldPath !== undefined) {
    row.child(div().flex_shrink(1).min_w(0).max_w(160).truncate().text_size(11).text_color(t.dim).child(`← ${printable(change.oldPath)}`));
  }
  if (discardable && !actions.busy && actions.hoveredRow === rowId) {
    row.child(div().id(`discard-${change.group}:${change.path}`).flex_none().w(18).h(18).rounded(3)
      .flex().items_center().justify_center().text_size(11).cursor_pointer()
      .hover((s) => s.bg(t.raised))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        actions.discard(change);
      })
      .child("🗑"));
  }
  return row;
}

/** A centred title and explanation for a state with nothing to list. */
function screen(t, title, detail) {
  return v_flex().flex_1().min_h(0).items_center().justify_center().gap(6).p(16)
    .child(div().font_weight(600).child(title))
    .child(div().text_size(12).text_color(t.muted).text_center().child(detail));
}
