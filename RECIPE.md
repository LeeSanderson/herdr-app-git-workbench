# Git Workbench

A Source Control panel docked beside the terminals, and a Diff view in its own tab
for each changed file. The panel follows the active space's Git repository: branch,
upstream, ahead/behind, the changes in Unstaged and Staged lists with checkboxes,
and a commit box. Clicking a change opens a side-by-side (or inline) diff.

![Git Workbench](preview.png)

## What you see

- **Source Control panel:** a 340 px column (min 280, max 900) to the right of
  Herdr's Files/Changes panel, hidden until `Ctrl+Shift+G`. Top to bottom:
  - Top bar: `⎇ branch → upstream`, an `↑a ↓b` pill when there is an upstream, an
    operation badge (Merging, Rebasing, Cherry-picking, Reverting), then ⟳ (refresh)
    and ✕ (hide). A detached HEAD shows "detached HEAD" in `ansi3` and the short oid.
  - A running strip ("Staging…", "Committing…") while a Git command runs, and a red
    error strip (summary, with a Details toggle) after a failed action.
  - **Unstaged** header with **Stage all**, a red Conflicts banner when there are
    Conflicts, then the Conflicts, Changes and Untracked rows. **Staged** header with
    **Unstage all**, then the staged rows.
  - Each row: checkbox, status letter (`M`/`T` `ansi3`, `A` and untracked `U`
    `ansi2`, `D` and conflict `!` `ansi1`, `R` `ansi4`), file name, dim folder.
    Hovering an unstaged row shows 🗑. The selected row has a `raised` background.
  - Commit box at the bottom: a 3-row textarea, a status line ("2 files ready",
    "Nothing staged", "Resolve 1 conflict first"), and **Commit to &lt;branch&gt;**.
  - Other states: "Git not found", "No repository" (with the folder), loading.
- **Diff view:** a tab named `Δ <file>` (`Δ <file> (staged)` for the staged side).
  Header: status chip, dim folder and bold name, a Staged/Unstaged/Untracked/Conflict
  badge, `+N −M`, "Change k of N" with ↑/↓, and a "Side by side | Inline" switch.
  Body: one virtual list of rows, `ceil(font_size × 1.6)` px each, with line numbers;
  added rows `ansi2` + `1c` alpha, removed `ansi1` + `1c`, the changed middle of a
  modified line at `55` alpha, an empty half in `canvas`, gap rows in `raised`, and a
  3 px `accent` bar on the current change. A thin notice band for binary, new,
  deleted and untracked files, a large-file fallback, or a mode change.

## How it behaves

- The panel follows the active space's `folder` (not the focused terminal's cwd).
  It refreshes from a debounced (400 ms) watch of the work tree and the git dir,
  after every Workbench action, and when the space changes, the window becomes
  active or the panel gets focus. No timed polling.
- Ticking a row stages it (`git add`) or unstages it (`git restore --staged`, or
  `git reset` on an unborn branch). Ticking a Conflict marks it resolved. Repository
  changing commands go through one queue per repository (linked worktrees share
  their main repository's queue); actions are disabled while one runs.
- 🗑 opens Herdr's `confirm` dialog; Confirm restores the file (`git restore
  --worktree`) or deletes an untracked file (`git clean -f`). Cancel does nothing.
- Commit runs `git commit -m <message>` with hooks; a hook failure shows in the
  error strip. `Ctrl+Enter` in the textarea does the same as the button.
- Panel keys: `↑`/`↓` select, `Space` stage/unstage, `Enter` open diff, `Delete`
  discard (Changes and Untracked), `Tab` to the commit box. Off while typing.
- Diff keys: `n`/`F7`, `p`/`Shift+F7`, `←`/`→`/`Home` pan, `i` mode, `r` reload.
  The mode is shared by every Diff view and remembered.
- Clicking a change whose Diff tab is open selects that tab instead of opening
  another.
- Mod commands `refresh`, `stage_all`, `unstage_all`, `commit` act only in the
  panel copy, and only while it is shown.

## Built from

- **Mod `herdr-app-git-workbench`**, `mod.json` `{ "place": "none", "focusable": true }`.
  One `View` in `main.js`; each copy picks its role from `props().view`: none or
  `"panel"` is the Source Control panel, `"diff"` (with `props().diff`, a Diff target)
  is a Diff view. Module scope holds one shared Workbench for all copies.
- `src/core/` (no Herdr imports, tested with `node --test` against real temporary
  repositories): Git runner and discovery, status parsing (`git status
  --porcelain=v2 -z --branch --untracked-files=all`), Repository snapshots, the
  command queue, watch filtering, diff loading and row building. It reaches Herdr
  only through a platform object `{exec, watch, readTextFile, sleep, gitCandidates}`.
- `src/ui/`: the panel, the Diff view, the tab registry and the Herdr platform.
- **`herdr` functions:** `exec`, `readTextFile`, `watchFolder`, `spaces`, `focused`,
  `panes`, `home`, `theme`, `settings`, `shared`/`setShared` (`gitwb.diffMode`),
  `nextCommand`, `openOverlay`, `run`, `checking`, `window`.
- **Commands it runs:** `tab.new`, `tab.select`, `layout.hide {id: "git-workbench"}`.
- **Shipped mods it uses:** `confirm` (discard dialog), with
  `command: {name: "herdr-app-git-workbench.discard"}`.
- **Programs:** `git` from `PATH`, else `C:\Program Files\Git\cmd\git.exe` or
  `%LOCALAPPDATA%\Programs\Git\cmd\git.exe`.
- **Layout block** (in a personal clone of `main`, `work-body` row, after `panel`):
  `{"id":"git-workbench","type":"block","hidden":true,"size":{"px":340},"min":280,"max":900,"content":{"mod":"herdr-app-git-workbench"}}`
- **`keys.json`:** `{"global": {"ctrl-shift-g": "layout.toggle:git-workbench"}}`.

## Install

Follow README.md's Install section: copy the folder as a real folder, clone the
shown layout if it is a shipped one (ask first), add the `git-workbench` block with
`layout.set` only if no node has that id, merge `keys.json` asking before
replacing a key the person uses, then `herdr-app check`. Fallback without a
personal layout: `pane.split {"direction": "right", "mod": "herdr-app-git-workbench"}`.
The mod runs `git` in the active space's folder and reads files under its `.git`;
it does not reach the network.

## Watch out

- `"place": "right"` would make Herdr auto-dock a second copy the first time a
  personal layout shows. Keep `"none"`; the install adds the block.
- Shipped layouts are read-only to structure: the block needs a personal layout.
- The mod runtime has no `setTimeout`, `process.env` or Node APIs. Timers come
  from `cx.timer` / `cx.sleep` in a host task spawned with `{owner: null}`.
- `run("tab.new")` returns null: read the new tab's id from `focused()` after it.
- `watchFolder` resolves once per batch; re-arm it. On Windows it reports `.git`
  and ignored folders too, so filter (lock files, `objects/`, logs) before refreshing.
- Mod-command arguments are dropped, and commands reach shown copies only, so the
  discard confirmation works by remembering the pending change in the panel.
- Conflicts produce a combined diff (`@@@`, two prefix columns).
- `git restore --staged` fails on an unborn branch: use `git reset -q -- <paths>`.
- `flex_shrink()` needs an argument; a `v_virtual_list` needs a definite height and
  `w_full()` rows; in a `mod.open` overlay, absolutely positioned lists collapse.
- No syntax highlighting (no tokenizer for mods), no 3-way merge.

## Done when

- `npm test` passes and `herdr-app check` on the mod folder reports no errors.
- `Ctrl+Shift+G` shows and hides the panel; ✕ hides it.
- In a repository with a modified, an untracked and a staged file, each is in the
  right list; ticking moves it between Unstaged and Staged, and `git status` agrees.
- Clicking a modified file opens a `Δ <file>` tab with tints and intra-line detail;
  clicking it again selects the same tab.
- 🗑 then Confirm restores the file; Cancel leaves it.
- A commit with a message empties the Staged list and the box; a failing
  `pre-commit` hook shows its output in the error strip.
- Running `git commit` in a terminal updates the panel without a click.
