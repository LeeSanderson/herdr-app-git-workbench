// @ts-check
// The Source Control panel: follows the active space and shows the Workbench state.

import { div } from "gpui-kit";
import { spaces, home, theme, run, checking, nextCommand, openOverlay, window } from "herdr";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { statusLetter, statusColor, printable, folderOf, nameOf, scrollArea } from "./theme.js";
import { diffTargetFor } from "../core/diff-target.js";
import { commitReadiness } from "../core/commit.js";
import { isDiscardable, unstagedChanges } from "../core/status.js";
import { openDiff } from "./diff-tabs.js";
import { listRows, listKeyAction, moveSelection, settleSelection, rowKey } from "../core/panel-keys.js";

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
    this.error = null;
    /** The lastError whose detail toggle is shown, and whether its detail is open. */
    this.shownError = null;
    this.showDetail = false;
    /** The row the pointer is over (its id), which shows its 🗑. @type {string | null} */
    this.hoveredRow = null;
    /**
     * The Change the confirm dialog asks about, and the snapshot it was taken from.
     * Valid only for the next "discard", and only while that snapshot is current.
     * `focusSkipped`: the one focus refresh it may hold back has been held back.
     * @type {{ repositoryId: string, snapshot: any, change: import("../core/status.js").Change, focusSkipped: boolean } | null}
     */
    this.pendingDiscard = null;
    this.handle = cx.focus_handle();
    /** What the last render saw of focus: the active space, window and panel focus. */
    this.seenFocus = { space: /** @type {string | null} */ (null), window: false, panel: false };
    /** The commit message box. Typing re-renders so the status line follows the message. */
    this.message = TextareaState.new({ placeholder: "Message (Ctrl+Enter to commit)", rows: 3 });
    this.message.on("change", (_e, cx) => cx.notify());
    // Ctrl/Cmd+Enter: the textarea reports it as a secondary submit (plain Enter is a newline).
    this.message.on("submit", (e, _cx) => {
      if (e.secondary) this.commit();
    });
    /** True from a commit's start until it resolves, so one press can't commit twice. */
    this.committing = false;
    /** The selected list row (keyboard). @type {import("../core/panel-keys.js").Selection | null} */
    this.selection = null;
    /** True while the commit box has the keyboard: the list keys stay off. */
    this.typing = false;
    this.message.on("focus", () => { this.typing = true; });
    this.message.on("blur", () => { this.typing = false; });
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
          if (command === "focus") {
            this.handle.focus();
            this.refreshForFocus();
          } else if (command === "discard") this.confirmDiscard();
          else this.modCommand(command);
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
    this.pendingDiscard = { repositoryId: repository.id, snapshot: repository.snapshot, change, focusSkipped: false };
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
    const repository = this.pendingRepository();
    const pending = this.pendingDiscard;
    this.pendingDiscard = null;
    if (!repository || !pending) return;
    const { group, path } = pending.change;
    const listed = repository.snapshot.groups[group]?.some((c) => c.path === path);
    if (listed && isDiscardable(pending.change)) void repository.discard([path]);
  }

  /**
   * The followed Repository while the pending discard is still valid (same Repository,
   * no refresh since the dialog opened), else null.
   */
  pendingRepository() {
    const pending = this.pendingDiscard;
    const state = this.workbench.state;
    if (!pending || state.kind !== "ready") return null;
    const { repository } = state;
    return repository.id === pending.repositoryId && repository.snapshot === pending.snapshot ? repository : null;
  }

  /**
   * Follows the active space when the shared Workbench follows somewhere else
   * (another space, or another copy moved it while this one was hidden).
   * Render re-runs when spaces change.
   */
  follow() {
    if (checking()) return;
    const where = activeSpace();
    if (!where || this.workbench.isFollowing(where)) return;
    this.error = null;
    this.workbench.follow(where).catch((err) => {
      this.error = String(err?.message ?? err);
    });
  }

  /** Forces a refresh of the followed Repository (merges with one already running). */
  refresh() {
    const state = this.workbench.state;
    if (state.kind === "ready") state.repository.refresh().catch(() => {});
  }

  /**
   * Refreshes when the panel, the window or a space gets focus. Render re-runs
   * when Herdr's focus and spaces change, so this compares with the last render.
   * A space switch to another Repository is covered by `follow` instead.
   */
  refreshOnFocus() {
    if (checking()) return;
    const now = {
      space: spaces().find((s) => s.active)?.id ?? null,
      window: window()?.active ?? false,
      panel: this.handle.is_focused(),
    };
    const was = this.seenFocus;
    this.seenFocus = now;
    if (now.space !== was.space || (now.window && !was.window) || (now.panel && !was.panel)) this.refreshForFocus();
  }

  /**
   * A focus-triggered refresh. The first one while a discard confirmation is still
   * valid is skipped: the confirm dialog closing gives the panel focus, possibly just
   * before "discard" arrives, and a refresh landing first would void the Confirm.
   * Only one is skipped, so a cancelled dialog can't keep focus refreshes off.
   */
  refreshForFocus() {
    const pending = this.pendingDiscard;
    if (pending && !pending.focusSkipped && this.pendingRepository()) {
      pending.focusSkipped = true;
      return;
    }
    this.refresh();
  }

  /**
   * Commits the staged files with the box's message, exactly as the button does.
   * Does nothing while blocked (see commitReadiness) or while a command runs.
   * Clears the box on success; a failure lands in snapshot.lastError.
   */
  async commit() {
    const state = this.workbench.state;
    if (this.committing || state.kind !== "ready") return;
    const { repository } = state;
    const s = repository.snapshot;
    const message = this.message.value();
    if (!s || s.running !== null || !commitReadiness(s.groups, message).ready) return;
    this.committing = true;
    try {
      const result = await repository.commit({ message });
      if (result.ok) this.message.set_value("");
    } finally {
      this.committing = false;
    }
  }

  /**
   * The mod commands power users bind or script (`herdr-app-git-workbench.<name>`).
   * Only shown copies receive commands, so a hidden panel ignores them; Diff views
   * have no command loop. Unknown names are ignored.
   * @param {string} command
   */
  modCommand(command) {
    if (command === "refresh") this.refresh();
    else if (command === "stage_all") this.stageAll();
    else if (command === "unstage_all") this.unstageAll();
    else if (command === "commit") void this.commit();
  }

  /** The ready Repository and its snapshot, or null. */
  current() {
    const state = this.workbench.state;
    if (state.kind !== "ready" || !state.repository.snapshot) return null;
    return { repository: state.repository, s: state.repository.snapshot };
  }

  /** Stages every unstaged row (Conflicts are marked resolved), like the Stage all button. */
  stageAll() {
    const cur = this.current();
    if (!cur || cur.s.running !== null) return;
    const unstaged = unstagedChanges(cur.s.groups);
    if (unstaged.length) void cur.repository.stage(unstaged.map((c) => c.path));
  }

  /** Unstages every staged row, like the Unstage all button. */
  unstageAll() {
    const cur = this.current();
    if (!cur || cur.s.running !== null || !cur.s.groups.staged.length) return;
    void cur.repository.unstage(cur.s.groups.staged.flatMap(pathsOf));
  }

  /**
   * The list keys: Up/Down select, Space stages/unstages (or marks a Conflict resolved),
   * Enter opens the Diff view, Delete asks to discard, Tab goes to the commit box.
   * Off while the commit box has the keyboard.
   * @param {import("gpui-kit").KeyEvent} e @param {import("gpui-kit").Context} cx
   */
  onListKey(e, cx) {
    if (this.typing || !this.handle.is_focused()) return;
    const cur = this.current();
    const rows = cur ? listRows(cur.s.groups) : [];
    const selection = settleSelection(rows, this.selection);
    const row = selection ? rows[selection.index] : null;
    const action = listKeyAction(e.keystroke, row?.change ?? null);
    if (!action) return;
    cx.stop_propagation();
    if (action === "commit-box") {
      if (cur) this.message.focus();
      return;
    }
    if (action === "up" || action === "down") {
      this.selection = moveSelection(rows, selection, action === "up" ? -1 : 1);
      cx.notify();
      return;
    }
    if (!cur || !row) return;
    const { repository, s } = cur;
    const change = row.change;
    if (action === "open") openDiff(diffTargetFor(repository.key, change));
    else if (s.running !== null) return; // Stage/unstage/discard wait, as the disabled controls do.
    else if (action === "toggle") {
      if (change.group === "staged") void repository.unstage(pathsOf(change));
      else void repository.stage([change.path]);
    } else if (action === "discard") this.askDiscard(repository, change);
  }

  /** @param {import("gpui-kit").Context} _cx */
  close(_cx) {
    this.message.release();
  }

  /** @param {import("gpui-kit").Context} _cx */
  render(_cx) {
    // Order matters: a space switch that changes Repository is followed first, and
    // refreshOnFocus then only refreshes the (already current) Repository again,
    // which merges into the follow's own refresh or is a cheap re-read.
    this.follow();
    this.refreshOnFocus();
    const t = theme();
    const state = this.workbench.state;
    return v_flex()
      .size_full()
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onListKey(e, cx))
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
      if (s.detached) {
        bar.child(div().flex_none().font_weight(600).text_color(t.ansi3).child("detached HEAD"));
        if (s.headOid) bar.child(div().flex_none().text_size(11).text_color(t.dim).child(s.headOid.slice(0, 7)));
      } else {
        bar.child(div().flex_shrink(1).min_w(0).truncate().font_weight(600).child(s.branch ?? ""));
      }
      if (s.upstream !== null) {
        bar.child(div().flex_none().text_color(t.dim).child("→"));
        bar.child(div().flex_shrink(1).min_w(0).truncate().text_color(t.muted).child(s.upstream));
      }
      if (s.ahead !== null && s.behind !== null) bar.child(aheadBehindPill(t, s.ahead, s.behind));
      if (s.unborn) bar.child(div().flex_none().text_size(11).text_color(t.dim).child("no commits yet"));
      if (s.operation !== "none") bar.child(operationBadge(t, s.operation));
    } else {
      bar.child(div().min_w(0).truncate().text_color(t.muted).child("Source Control"));
    }
    return bar
      .child(div().flex_1())
      .child(
        div().id("refresh").flex_none().w(22).h(22).flex().items_center().justify_center().rounded(4)
          .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.refresh();
          })
          .child("⟳"),
      )
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
        this.selection = settleSelection(listRows(s.groups), this.selection);
        /** @type {Actions} */
        const actions = {
          busy: s.running !== null,
          // Nothing is staged except what the user ticks. Results land in snapshot.lastError.
          stage: (changes) => void repository.stage(changes.map((c) => c.path)),
          unstage: (changes) => void repository.unstage(changes.flatMap(pathsOf)),
          stageAll: () => this.stageAll(),
          unstageAll: () => this.unstageAll(),
          open: (change) => {
            // A clicked row becomes the selected one, so the keys carry on from there.
            this.selection = settleSelection(listRows(s.groups), { key: rowKey(change), index: 0 });
            openDiff(diffTargetFor(repository.key, change));
          },
          selectedKey: this.selection?.key ?? null,
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
          .when(s.watchError !== null, (e) => e.child(watchBand(t, s.watchError)))
          .child(changeLists(t, s.groups, actions))
          .child(this.commitBox(t, s));
      }
      default:
        return div();
    }
  }

  /**
   * The commit box at the bottom: the message, a status line ("N file(s) ready" or
   * why commit is blocked) and the Commit to <branch> button.
   * @param {Record<string, string>} t @param {import("../core/repository.js").Snapshot} s
   */
  commitBox(t, s) {
    const { ready, status } = commitReadiness(s.groups, this.message.value());
    const enabled = ready && s.running === null;
    return v_flex().id("commit-box").flex_none().p(10).gap(6).border_t_1().border_color(t.border).bg(t.chrome)
      // Fallback for Ctrl+Enter in case the textarea doesn't report it as a secondary submit.
      .on_key_down((e, cx) => {
        if (e.keystroke === "ctrl-enter" || e.keystroke === "cmd-enter") {
          cx.stop_propagation();
          this.commit();
        }
      })
      .child(Textarea.new(this.message))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(ready ? t.muted : t.dim).child(status))
        .child(h_flex().id("commit").flex_none().h(24).px(10).items_center().justify_center().rounded(4)
          .text_size(12).font_semibold()
          .bg(enabled ? t.accent : t.raised).text_color(enabled ? t.accent_foreground : t.dim)
          .when(enabled, (e) => e.cursor_pointer().hover((st) => st.opacity(0.85))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.commit();
            }))
          .child(`Commit to ${s.branch ?? "detached HEAD"}`)));
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
 *   stageAll(): void,
 *   unstageAll(): void,
 *   open(change: import("../core/status.js").Change): void,
 *   selectedKey: string | null,
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
  const unstaged = unstagedChanges(groups);
  const row = (c) => changeRow(t, c, actions);
  return v_flex().flex_1().min_h(0)
    .child(listHeader(t, "Unstaged", unstaged.length,
      button(t, "stage-all", "Stage all", () => actions.stageAll(), actions.busy || !unstaged.length)))
    .when(groups.conflicts.length > 0, (e) => e.child(conflictBanner(t, groups.conflicts.length)))
    .child(scrollArea("unstaged", unstaged.length ? unstaged.map(row) : [emptyNote(t, "No changes")]))
    .child(listHeader(t, "Staged", groups.staged.length,
      button(t, "unstage-all", "Unstage all", () => actions.unstageAll(), actions.busy || !groups.staged.length)))
    .child(scrollArea("staged", groups.staged.length ? groups.staged.map(row) : [emptyNote(t, "Nothing staged")]));
}

/**
 * The red banner above the Unstaged list while Conflicts remain. The Workbench never edits
 * conflict content: the user fixes it in an editor, then ticks the row (which stages it).
 * @param {Record<string, string>} t @param {number} count
 */
function conflictBanner(t, count) {
  return div().id("conflict-banner").flex_none().px(10).py(6).text_size(11)
    .bg(t.ansi1 + "22").text_color(t.ansi1).border_b_1().border_color(t.border)
    .child(`${count} conflict(s): fix them in your editor, then tick to mark resolved`);
}

/**
 * Shown once the file watch has stopped: the panel no longer sees outside edits by itself.
 * @param {Record<string, string>} t @param {string} reason
 */
function watchBand(t, reason) {
  return div().id("watch-error").flex_none().px(10).py(6).text_size(11)
    .bg(t.ansi3 + "22").text_color(t.ansi3).border_b_1().border_color(t.border).truncate()
    .child(`Not watching for changes (${reason}) · ⟳ or focus refreshes`);
}

/** `↑ahead ↓behind` against the upstream. @param {Record<string, string>} t @param {number} ahead @param {number} behind */
function aheadBehindPill(t, ahead, behind) {
  return div().id("ahead-behind").flex_none().px(6).h(18).flex().items_center().rounded(9).text_size(11)
    .bg(t.raised).text_color(ahead || behind ? t.foreground : t.dim)
    .child(`↑${ahead} ↓${behind}`);
}

const OPERATION_LABELS = { merge: "Merging", rebase: "Rebasing", "cherry-pick": "Cherry-picking", revert: "Reverting" };

/** The Operation in progress, e.g. "Merging". @param {Record<string, string>} t @param {string} operation */
function operationBadge(t, operation) {
  return div().id("operation").flex_none().px(6).h(18).flex().items_center().rounded(4).text_size(11)
    .font_semibold().bg(t.ansi3 + "33").text_color(t.ansi3)
    .child(OPERATION_LABELS[operation] ?? operation);
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
 * Clicking it opens the Change's Diff view.
 * @param {Record<string, string>} t @param {import("../core/status.js").Change} change @param {Actions} actions
 */
function changeRow(t, change, actions) {
  const path = printable(change.path);
  const rowId = `row-${change.group}:${change.path}`;
  const selected = actions.selectedKey === rowKey(change);
  const discardable = isDiscardable(change);
  const row = h_flex().id(rowId).flex_none().h(24).px(10).gap(8).items_center()
    .cursor_pointer().when(selected, (e) => e.bg(t.raised)).hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => {
      cx.stop_propagation();
      actions.open(change);
    })
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
