# Git Workbench

Git source control and a visual diff for [Herdr Desktop](https://herdr.dev).

![Git Workbench](preview.png)

- **Source Control panel:** opened beside your terminals from the command palette
  (`Ctrl+Shift+P`, "Git Workbench: Open Source Control beside this pane"), or kept
  as a column in a personal layout. It follows the repository of the terminal you
  last focused in the shown space, and shows the branch,
  its upstream and ahead/behind counts, any merge, rebase, cherry-pick or revert in
  progress, and your changes in two lists: Unstaged (Conflicts, Changes, Untracked)
  and Staged. Tick a row to stage or unstage it. Hover a row and click 🗑 to discard
  it (you are asked first). Write a message in the commit box and press
  **Commit to &lt;branch&gt;** or `Ctrl+Enter`.
- **Graph:** a collapsible section below the Change groups, behind a divider you
  can drag (its position is remembered per repository). It lists commits newest first with coloured lanes, Ref badges (HEAD,
  branches, remote branches, tags) and a two-line summary. Click a commit to expand
  it in place (details and changed files); click a file to open its Diff view
  against the commit's first parent. The **Auto | All | Current** Ref filter picks
  HEAD and its Upstream, every branch and tag, or HEAD only, and is remembered per
  repository. The first 50 commits load, then **Load more…** adds 50. The toolbar
  has **Fetch**, **Pull ↓n**, **Push ↑n** (**Publish** for a branch with no
  Upstream), ⌖ (go to current) and ⟳ (reload). See [Sync](#sync).
- **Diff view:** click a change to open it in its own tab. Side-by-side and inline
  modes, line numbers, added/removed/modified tints with intra-line detail, change
  navigation, and handling for long lines, large files, binary files, renames and
  new or deleted files. Clicking the same change again goes back to its tab.

The panel keeps itself up to date: it watches the repository, refreshes after every
Workbench action, and refreshes when it or the window gets focus. Workbench commands
that change the repository run one at a time. The Graph reloads when HEAD or any Ref
moves (from a terminal too), after a commit and after every sync, but not when you
edit files. A reload keeps your expanded commits, selection and scroll position.
History loads beside the command queue, so you can stage and commit while it loads.

It needs Git. If `git` is not on your `PATH`, the Workbench also looks in Git for
Windows' standard install folders.

**What it does on your machine:** it runs `git` (through Herdr's `exec`) in the
folder of the terminal you last focused (or the space's folder), and reads files
under that repository's `.git` folder. It reaches the network only when you press Fetch, Pull, Push or Publish, and then
only through Git. It never handles credentials: sign-in is left to Git and its
credential helper.

## Sync

Fetch, Pull and Push run Git with safe defaults:

- **Fetch** fetches every remote. It prunes only if your `fetch.prune` says so.
- **Pull** follows your `branch.<name>.rebase`, `pull.rebase` and `pull.ff`
  config. With none set, it fast-forwards only. `pull.rebase=interactive` (or
  `branch.<name>.rebase=interactive`) runs as a plain rebase in the Workbench:
  there is no editor to show the todo list. It never stashes your changes:
  if a pull would overwrite local changes, it says how many files and asks you to
  commit or discard them first. If your branch has diverged from its Upstream, it
  offers a one-off **Pull (merge)** or **Pull (rebase)**, which changes no config.
  If a pull stops with Conflicts, the Conflicts group and the Operation in progress
  take over.
- **Push** never forces, not even with `--force-with-lease`. If the remote has new
  commits, it says to pull first and offers **Pull**.
- **Publish** pushes the branch and sets its Upstream. The remote is the branch's
  `pushRemote`, then `remote.pushDefault`, then the only remote, then `origin`.
  If none applies, it shows an error; there is no remote picker.

Pull is the primary button when you are behind, Push when you are ahead and not
behind. A detached HEAD or an Operation in progress disables Pull and Push; no
Upstream disables Pull. Fetch is always available while nothing else runs.

**Sign-in:** a sync can open a Git Credential Manager window, which may hide
behind Herdr. After about 15 seconds the running label adds "still waiting — a
sign-in window may be open". If sign-in fails,
the message names the remote and suggests running the same command (for example
`git fetch`) in a terminal once; **Details** shows Git's full output.

**Stalls and timeouts:** a sync asks Git to give up on an HTTP(S) remote that
sends nothing for 2 minutes (`http.lowSpeedLimit=1`, `http.lowSpeedTime=120`),
and then says the sync stalled. Waiting for sign-in doesn't count as a stall. If
you set `http.lowSpeedLimit` or `http.lowSpeedTime` yourself (also per URL), the
Workbench uses yours. SSH remotes aren't covered.

A sync times out after 10 minutes. The message then says Git may still be
running: Herdr stops waiting, but on Windows it can't stop Git itself. If a
sign-in window is still open, finishing sign-in lets the sync complete, and for a
Pull that includes its merge or rebase; closing the window cancels it. A timeout
can't show Git's output: Herdr's `exec()` drops the output of a command it stops,
so **Details** shows only the timeout.

## Install

You need [Herdr Desktop](https://herdr.dev) and Git.

**Ask your Herdr agent:** *"add the mod at
github.com/LeeSanderson/herdr-app-git-workbench"*. It copies
`mods/herdr-app-git-workbench/` into `~/.config/herdr-app/mods/` and checks it.

**Or by hand:**

```sh
git clone https://github.com/LeeSanderson/herdr-app-git-workbench.git
cp -R herdr-app-git-workbench/mods/herdr-app-git-workbench ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/herdr-app-git-workbench
```

In PowerShell, use `Copy-Item -Recurse` instead of `cp -R`. Copy the folder; don't link
it, because Herdr's hot reload ignores changes made through a symlink or junction.

Then press `Ctrl+Shift+P` and run **Git Workbench: Open Source Control beside
this pane**. That's all the mod needs. It binds no keys, and it does not dock
itself anywhere (`"place": "none"` in `mod.json`).

**Update:** copy the folder again over the old one. **Uninstall:** delete
`~/.config/herdr-app/mods/herdr-app-git-workbench`, and undo any layout or key
changes from the next section.

### Optional: a column in your layout

The palette opens the panel as a pane in the current tab. To keep it in a column
of its own beside the terminals, add it to a personal layout. Herdr's shipped
layouts are read-only, so this needs one. These steps work for a person or an
agent. They change Herdr's state, so an agent asks before each one.

There is no palette entry to toggle the layout column: a palette entry cannot
check whether the shown layout has that column, and on a layout without it
`layout.toggle` fails with "no node". With the column, use the panel's ✕ and a
key you bind yourself (see
[Optional: a key to toggle the panel](#optional-a-key-to-toggle-the-panel)).

#### 1. Use a personal layout

Herdr's own layouts (`main`, `terminals`, `win98`) are read-only, so the panel
needs a personal layout. `herdr-app status` (or `shared("layout")` in a mod) names
the layout that is shown.

- If it is already a personal layout (a file you made in
  `~/.config/herdr-app/layouts/`), use it and go to step 2.
- If it is a shipped one, **ask first**, then clone it:

  ```sh
  herdr-app do layout.clone '{"name":"main","as":"my-layout"}'
  ```

  This switches to the clone. Tell the person that the clone is theirs and does
  not get later changes to `main`, and that `Ctrl+Shift+L` switches between
  layouts. The Workbench column fits `main`'s shape; for another shipped layout,
  find a row to put it in by hand.

Want to keep the shipped layout? Skip this section and open the panel as a
[pane](#using-the-panel-as-a-pane).

#### 2. Add the `git-workbench` column, once only

Read the personal layout, `~/.config/herdr-app/layouts/<name>.json`.

1. **If any node already has `"id": "git-workbench"`, stop here:** the column is
   already there. Never add it twice.
2. Find the row with `"id": "work-body"`. In its `children`, right after the node
   with `"id": "panel"` (Herdr's Files/Changes column), insert:

   ```json
   {
     "id": "git-workbench",
     "type": "block",
     "hidden": true,
     "size": { "px": 340 },
     "min": 280,
     "max": 900,
     "content": { "mod": "herdr-app-git-workbench" }
   }
   ```

3. With that layout shown, apply the whole edited tree:

   ```sh
   herdr-app do layout.set '{"layout": <the edited tree>}'
   ```

The column starts hidden. The id `git-workbench` is what `layout.toggle` and the
panel's ✕ button use, so keep it exactly.

Show it once to check it:

```sh
herdr-app do layout.toggle '{"id":"git-workbench"}'
```

The Source Control panel appears beside your terminals. To show and hide it from
the keyboard, bind a key (next section).

### Optional: a key to toggle the panel

For a layout with the `git-workbench` column. The mod binds no keys. If you want
one, add it to `~/.config/herdr-app/keys.json` yourself, for example:

```json
{ "global": { "ctrl-shift-g": "layout.toggle:git-workbench" } }
```

Pick a key you don't already use (an agent asks first). To bind it for one layout
only, put it in a `"layout:<name>"` section instead of `global`. Note: Herdr adds
new default shortcuts only to an untouched `keys.json`; after any edit the whole
file is yours, and later defaults must be added by hand.

### Using the panel as a pane

Without the layout column, run **Git Workbench: Open Source Control beside this
pane** from the command palette, or from a terminal:

```sh
herdr-app do pane.split '{"direction":"right","mod":"herdr-app-git-workbench"}'
```

The pane belongs to its tab. Diff views open in new tabs, so the panel leaves the
screen when one opens; switch back to its tab to see it again. The panel's ✕ button
hides the layout column and does nothing in a pane: close the pane with
`pane.close` instead. Each run opens another pane.

To try the panel without any change, `herdr-app do mod.open
'{"name":"herdr-app-git-workbench"}'` opens it as an overlay (run it again to
close it).

## Keys

The mod binds no global keys. Open the panel from the command palette. With the
layout column, bind `layout.toggle:git-workbench` yourself (see
[Optional: a key to toggle the panel](#optional-a-key-to-toggle-the-panel)).

### Source Control panel

These work while the panel has focus (click it, or move to it with Herdr's
`pane.go` keys).

| Key | Does |
|---|---|
| `↑` / `↓` | Move the selected row |
| `Space` | Stage or unstage the selected row; on a Conflict, mark it resolved |
| `Enter` | Open the selected row's Diff view |
| `Delete` | Discard the selected row, after you confirm (Changes and Untracked only) |
| `Tab` / `Shift+Tab` | Move focus: Change list → commit box → Graph, and back |
| `Ctrl+Enter` | In the commit box: commit, same as the button |

The list keys do nothing while you type in the commit box.

### Graph

These work while the Graph has focus (click it, or `Tab` to it).

| Key | Does |
|---|---|
| `↑` / `↓` | Move through commits and the file rows of expanded commits |
| `→` / `Space` | Expand the selected commit |
| `←` | Collapse the selected commit; on a file row, go to its commit |
| `Enter` | Expand or collapse the selected commit; on a file row, open its Diff view |

### Diff view

| Key | Does |
|---|---|
| `n` / `F7` | Next change |
| `p` / `Shift+F7` | Previous change |
| `←` / `→` / `Home` | Pan long lines left, right, back to the start |
| `i` | Switch between side-by-side and inline (remembered for every Diff view) |
| `r` | Reload |

## Mod commands (optional bindings)

These are not in the command palette: they reach only a panel that is on screen,
so from the palette they would often do nothing. Use them from `keys.json` or
`herdr-app do`. None is bound by default.

| Command | Does |
|---|---|
| `herdr-app-git-workbench.refresh` | Re-read the repository now |
| `herdr-app-git-workbench.stage_all` | Stage every unstaged change (same as **Stage all**) |
| `herdr-app-git-workbench.unstage_all` | Unstage everything (same as **Unstage all**) |
| `herdr-app-git-workbench.commit` | Commit, exactly like the **Commit to &lt;branch&gt;** button |

Bind any of them in `keys.json`, for example:

```json
{ "global": { "ctrl-shift-f5": "herdr-app-git-workbench.refresh" } }
```

or run one from a terminal:

```sh
herdr-app do herdr-app-git-workbench.stage_all
```

Pick keys you don't already use. Avoid plain `ctrl+<letter>` (terminal programs
need them), `ctrl+alt` (AltGr on Windows) and `alt+↑`/`alt+↓` (Herdr's agent keys).

`herdr-app-git-workbench.discard` also exists. The discard confirmation dialog
sends it; don't bind it.

## Limitations

- **No syntax highlighting** in the Diff view. Herdr gives mods no tokenizer, so
  lines show added/removed tints only.
- **No 3-way merge.** Conflicts are listed and shown as Git's combined diff.
  Resolve them in your editor or terminal, then tick the row to mark the Conflict
  resolved.
- **Commands are ignored while the panel is hidden.** Herdr delivers
  `herdr-app-git-workbench.<command>` only to copies that are shown, so a bound
  key does nothing until you show the panel.
- The panel follows the **folder of the terminal you last focused** in the shown
  space, so `cd` into another project and focus that terminal to follow it. Until
  a terminal in the space has had focus, it follows where the space's first
  terminal is now (the folder Herdr names the space after), else the space's
  folder (where its new terminals start).
- One repository at a time: the one for the shown space's focused terminal.
- Spaces on other machines are not tested. Herdr's file watch is local only, so a
  remote space refreshes only on actions, focus and the ⟳ button.
- A running Git command cannot be cancelled; actions stay disabled until it ends
  or times out.
- **The Graph has no commit actions:** no checkout, branch, cherry-pick, revert or
  reset from a commit, and no file history.
- **No Abort or Continue** for a merge or rebase that a pull leaves in progress. Use
  a terminal.
- **No background fetch.** The Graph shows remote commits as of your last Fetch.
- **A sync cannot be cancelled.** A timed-out sync can't show Git's output, because
  `exec()` drops it on a timeout; its Details show only the timeout. On Windows a
  timed-out sync's Git keeps running (see [Sync](#sync)): Herdr's `exec()` stops
  only the process it started, not Git's own child processes.
- Out of scope for this version: amend, branch management, hunk staging, stash and
  worktree management.

## Runtime checks

The automated tests cover the core (Git, status, the queue, diffs, history, lanes,
sync against a local bare remote). The UI is
checked by hand in the running app. Results for Herdr Desktop 0.1.18 on Windows:

| Check | Result |
|---|---|
| `Ctrl+Enter` in the commit box reaches the `Input` and commits | Pass |
| `pane.go` moves focus onto the panel, and the panel keys work | Pass: `Alt+←`/`Alt+→` move focus onto the panel and back; the list, commit box and Graph keys all work. Tab out of the commit box needed its own key binding, since the textarea binds Tab to indent |
| How many events `watchFolder` delivers for one change (e.g. a save, a `git commit`) | A save: 1 batch (now and then 2). `git add`: 2 batches. `git commit`: 1 batch of about 20 paths (objects, locks, refs, logs, index). Each burst gives one refresh (400 ms debounce). On Windows the paths come in verbatim form (`\\?\C:\...`); the filter accepts it. |
| `"place": "none"`: showing a personal layout does not auto-dock a second copy | Pass: a personal layout with the `git-workbench` block shows that one copy only; `main` shows none |
| Graph lane colours in light and dark themes | Pass: lanes, merge curves and badges are distinct and readable in `paper` (light) and in `graphite`, `ink`, `moss` and `atom-one-dark` |
| Graph scrolling speed | Pass: scrolling feels natural |
| Git Credential Manager sign-in from Fetch/Push, end to end | Pending |
| A sync timeout ends the `git` child process | **Fail.** On a timeout, `exec()` rejects ("took longer than … and was stopped") but stops only the process it started, Git for Windows' `cmd\git.exe` launcher. The real `git.exe` and its helpers (`git-remote-http.exe`, and so a sign-in window) keep running. Seen with a 5 s timeout against a server that never answers: all three were still running 30 s later. The mod can't stop them (it gets no process ids), so syncs now give up on a stalled HTTP remote by themselves, and the timeout message says Git may still be running. A sign-in window left open is still not stopped. |
| Graph load time for a few thousand commits | Pass: 5,000 commits with merges, 1,873 branches and 30 tags. The first page shows in under 1 s in the app. Git's query takes 0.5 s, about half of that Git's start-up on Windows; with 1,900 loose (unpacked) refs it takes 3–4 s, because `%D` reads every ref (`git pack-refs` or `git gc` fixes that). Lane layout of all 5,000 commits takes 40–115 ms under Node. |

## Development

Development needs Node 22. The mod is the folder `mods/herdr-app-git-workbench/`;
everything else in the repository (tests, scripts, docs) stays out of Herdr. The
mod runs from a copy in `~/.config/herdr-app/mods/herdr-app-git-workbench`, kept in
step with that folder by a sync script. A directory junction does not work:
Herdr's hot reload ignores saves made behind one.

```sh
npm test         # core tests: node --test against temporary Git repositories
npm run dev      # mirror the mod files, then copy on every save (hot reload)
npm run sync     # one-off mirror
herdr-app check ~/.config/herdr-app/mods/herdr-app-git-workbench
herdr-app do mod.open '{"name":"herdr-app-git-workbench"}'   # show it as an overlay
herdr-app shot shot.png
```

In the mod folder, `src/core/` is plain JavaScript with no Herdr imports and is
what the tests drive; `src/ui/` and `main.js` are the Herdr views. The tests run
the core through a Node platform port, `test/helpers/node-platform.js`. See `GLOSSARY.md` for the terms used
in the code.
