# How the Source Control panel gets into the layout

Research for issue #17 (map: #1). Herdr Desktop (herdr-app) 0.1.16, Windows.

**Question.** `mod.json` `"place": "right"` did not dock the Source Control panel, even after an
app restart, and the mod never appeared in `seen.json`. Why? And which way into the layout should
the Workbench use?

**Answer, short.**

- **Why no auto-dock (best-supported hypothesis, confidence about 75%):** the shown layout is the
  shipped `main` layout, and shipped layouts do not accept structural changes. Herdr cannot dock
  a `"place": "right"` mod into `main`, so it does not record the mod as seen and the dock stays
  pending. A mod with `"place": "none"` needs no dock, so Herdr records it at once. The junction
  and the mod name are not the cause.
- **Recommendation:** a block in a **personal layout** (a clone of `main`), as its own hidden
  right-hand column `git-workbench`, shown and hidden by a key binding (`layout.toggle`). A title-bar
  button is possible only by cloning the shipped `tabs` mod, so leave it out. A mod pane or a tab
  is the fallback for people who keep the shipped layout. A kept `window` overlay is rejected.
- **Install:** copy the mod folder, then run a one-time setup that clones the layout (if a shipped
  one is shown), inserts the block, and adds the key binding. The setup can be a view of the mod
  itself, opened once with `mod.open`.

All sources are local files that Herdr writes or ships. Line numbers are as of 0.1.16.

- `~/.config/herdr-app/AGENTS.md` (written by Herdr on every start, line 3)
- `~/.config/herdr-app/herdr.d.ts` (generated type file)
- `~/.config/herdr-app/mods/*` (shipped mods), `layouts/*.json`, `seen.json`, `keys.json`
- `herdr-app commands` (the app's own command list)
- `%LOCALAPPDATA%\Programs\herdr-app\herdr-app.exe` (strings: the bundled shipped mods' `mod.json`)
- The session log of issue #10, for the probe mod's `mod.json`

---

## 1. Why `"place": "right"` did not dock

### 1.1 What the docs promise

`AGENTS.md:890` and `:900-902`:

> `mod.json      where it first appears: { "place": "right" | "left" | "top" | "bottom" | "none", "size": 320 }`
>
> The first time Herdr sees a folder, it docks one copy per `mod.json` into the shown layout
> (`"none"`: only where a layout or another mod puts it). After that, the layouts decide.

The docs say "the shown layout". They do not say what happens when the shown layout is a shipped
one.

### 1.2 The shown layout is shipped, and shipped layouts are read-only

- `shared.json` has `"layout":"main"`. `main` is Herdr's own layout (`AGENTS.md:180-186`).
- `AGENTS.md:192-193`: "**Herdr's own layouts and mods are read-only.** They are replaced whole on
  every start."
- `herdr.d.ts:81` and `herdr-app commands`: `layout.set` replaces "a personal layout tree; shipped
  layouts accept only click/look fields (not structure)."
- Clicks on a shipped layout are stored in `layouts/.state/main.json`. That file has only node
  sizes and a copy of the file tree. There is no Workbench block in it, and no other place where a
  dock into `main` could live.
- The one other "add a mod to a layout by itself" rule in the docs is explicitly limited to
  personal layouts: "The first time a mod has link rules on a **personal layout**, Herdr adds it
  to that layout" (`AGENTS.md:947-948`).

A dock is a structural change. Herdr has nowhere to put it in `main`.

### 1.3 The evidence on this machine

| Mod folder | `mod.json` | Shown layout | In `seen.json`? |
|---|---|---|---|
| every shipped mod (`changes`, `files`, `tabs`, ...) | `{"place":"none", ...}` (all of them, see the bundled copies in `herdr-app.exe`) | `main` | yes |
| `zz-reload-probe` (issue #10 control, plain folder) | `{ "place": "none" }` (from the #10 session log) | `main` | **yes**, within seconds (`seen.json` written 2026-11-22 12:03:01) |
| `herdr-app-git-workbench` (junction, then plain folder since 2026-11-22 12:04) | `{ "place": "right", "size": 340 }` | `main` | **no** |

- The app restarted on 2026-11-23 at 19:08 (`AGENTS.md` and `installed.json` are rewritten at
  start and have that time). The Workbench was a plain folder then. `seen.json` was not rewritten
  and still does not list it.
- So the only difference between a mod Herdr records and the Workbench is `place` (`none`
  vs `right`), with `main` shown.

### 1.4 The causes that the evidence rules out

- **The junction.** The folder has been a real folder for more than a day, through a restart,
  and is still not recorded. The junction stopped hot reload (#10), but it does not explain this.
- **The mod name.** Hyphenated names are normal (`new-menu`, `machine-add`,
  `workspace-chrome`). Herdr loads, checks and opens the mod by this name. The prototype's pane and
  `mod.open` overlay worked (#10, #15). `data/herdr-app-git-workbench/` exists.
- **A version rule.** Nothing in the docs or in `installed.json` ties first-seen docking to a
  version. `installed.json` tracks only shipped files.

### 1.5 What is left

Herdr defers the dock until it can place it, and records the mod in `seen.json` only after the
dock. With `main` shown, that never happens. Whether this is intended or a bug, the docs do not
describe it, so it is at least a documentation gap that could go upstream.

Consequence for this machine today: the Workbench is still "unseen". **The first time the person
shows a personal layout, Herdr will probably dock it there as a right-hand block of 340 px.**

### 1.6 Experiment that would settle it (not run: it changes Herdr state)

Run it only with the person's consent. Restore everything after.

1. **No layout change.** Make `mods/zz-place-probe/` with a one-line `main.js` view and
   `{"place":"right"}`, with `main` shown. Wait 5 s. Expected: **not** in `seen.json`. Change it
   to `{"place":"none"}`. Expected: in `seen.json` within seconds. Delete the folder after.
2. **A personal layout.** `herdr-app do layout.clone '{"name":"main","as":"zz-dock-test"}'`
   (this switches to it). Expected: Herdr adds blocks for `herdr-app-git-workbench` (and for the
   probe, if it is still there) to `layouts/zz-dock-test.json` and adds them to `seen.json`.
   Note **where** the block lands (the root row's right edge, or beside the tab area) and its
   size. Check `herdr-app status` for warnings. Then `layout.switch {"name":"main"}` and delete
   `layouts/zz-dock-test.json`.

If step 1 shows the `"right"` probe recorded without a dock, the hypothesis is wrong, and the
next suspect is the junction at first sight (some "seen but unrecorded" state kept since then).

---

## 2. The ways into the window

### 2.1 What a mod can and cannot do before it is shown

- A mod's code runs only in a copy that is shown: a layout block, a pane, a tab, an overlay
  (`AGENTS.md:908-914`). `"<mod>.<command>"` "reaches shown copies only" (`AGENTS.md:914`).
  So a key bound to `herdr-app-git-workbench.<command>` does nothing while no copy is shown.
- The things that work with no copy shown are app commands: from a key in `keys.json`, from the
  palette ("every command by name", `herdr-app commands`), or from `herdr-app do` on the command
  line. Keys can pass typed arguments:
  `{"command": "pane.split", "args": {...}}` (`AGENTS.md:528-534`).
- `mod.open {name}` toggles the mod as an overlay with no layout change (#10).

### 2.2 Option A: a block in a layout (the panel stays beside every tab)

`main` is read-only, so every variant of A needs a **personal layout**:
`herdr-app do layout.clone '{"name":"main","as":"<name>"}'` (it switches to the clone,
`AGENTS.md:199-206`). Then edit `layouts/<name>.json` or call `layout.set {layout}`. Clones "are
yours and never updated" (`AGENTS.md:205`): later changes to `main` do not reach the clone.
The shipped mods that the clone uses (`tabs`, `files`, `changes`, ...) are still updated, because
the clone refers to them by name.

**A1: a third child of `panel-body`, next to `files` and `changes`, with a title-bar button.**

- The Files and Changes buttons are **hard-coded** in the shipped `tabs` mod
  (`mods/tabs/main.js:151-152`: `panelButton("files", ...)`, `panelButton("changes", ...)`).
  `shared("workspace.panels")` only hides one of those two buttons. There is no way to add a third
  button to the shipped `tabs`.
- A button needs `mod.clone tabs`, an edit to the clone, and the personal layout's `tabs` block
  pointing at the clone. The clone is then frozen: the person loses every later fix to the tab bar.
- Without a button, the shipped `tabs` mod still interferes. Its `syncPanel`
  (`mods/tabs/main.js:64-88`) remembers the open panel per space, but restores only ids in
  `workspace.panels` (`files`, `changes`). So the Source Control panel would close on every space
  switch. To show it, two commands are needed (`layout.select` and `layout.show`), and a key binds
  one command.
- Verdict: the nicest look, but it costs a frozen `tabs` clone. Not recommended.

**A2: its own column `git-workbench` in `work-body`, beside `panel` (recommended).**

- Insert a hidden column block in the clone's `work-body` row, after `panel`:
  `{"id":"git-workbench","type":"block","hidden":true,"size":{"px":340},"min":280,"max":900,
  "content":{"mod":"herdr-app-git-workbench"}}`.
- Show and hide it with one command: `layout.toggle {id}` (`herdr.d.ts:80`). Bind a key in
  `keys.json`: `"ctrl-shift-g": "layout.toggle:git-workbench"`. `ctrl-shift-g` is not bound in this
  `keys.json`. The panel's own close button runs `layout.hide {id: "git-workbench"}`. A key in a
  `layout:<name>` section keeps the binding to that layout.
- It does not touch `panel-body`, so the shipped `tabs` mod does not interfere. Files or Changes
  can be open at the same time.
- It stays visible across tabs. That matters because Diff views open as **new tabs** (#15): with a
  pane (option B) the Source Control panel would disappear each time a diff opens.
- It is the same shape that `"place": "right"` auto-docking produces on a personal layout, so a
  person who already uses a personal layout may get it for free (after the experiment in 1.6
  confirms where the dock lands).
- A copy "stays alive while its block is in the layout, shown or not" (`AGENTS.md:908-913`), so
  the panel's state and Repository watcher survive hiding it. Its timers keep running while
  hidden, so poll gently.

### 2.3 Option B: a mod pane or a tab (no layout change)

- `pane.split {direction: "right", mod: "herdr-app-git-workbench"}` worked in the prototype (#15).
  `tab.new {name, mod, props}` makes a tab whose only pane is the mod (`herdr.d.ts:57-58`). Both
  work on the shipped `main` layout. Both can be bound to a key with a typed-arguments binding.
- A pane belongs to its tab and is saved with it (`AGENTS.md:131-136`). It is not beside other
  tabs. Each Diff view opens a new tab (#15), so the Source Control panel would leave the screen at
  every click on a file. Opening a pane in each tab makes many copies.
- A Source Control **tab** has the same problem, worse: it is never beside the code.
- Verdict: a good fallback for a person who will not use a personal layout. It is also the setup
  view's "try it now" path.

### 2.4 Option C: a kept `window` overlay

- `openOverlay({kind: "window", key, keep: true, ...})` stays open until closed, reopens on the
  next start, and remembers where it was dropped (`herdr.d.ts:402-418`).
- But: "A layout switch closes windows" (`herdr.d.ts:407`). It floats over the terminals and
  over Diff views, which need the full width for side-by-side mode (#15). It needs its own drag
  bar (`AGENTS.md:1138-1145`). It does not take the keyboard when it opens.
- Verdict: rejected for the Source Control panel. It stays useful for small dialogs (#12, #15).

### 2.5 Comparison

| | A1 stack child + button | **A2 own column + key** | B pane / tab | C kept window |
|---|---|---|---|---|
| Works on shipped `main` | no | no | yes | yes |
| Stays beside every tab (Diff tabs) | yes | **yes** | no | yes, but covers content |
| Needs a cloned shipped mod | yes (`tabs`) | **no** | no | no |
| One key toggles it | no (two commands) | **yes** (`layout.toggle`) | opens only (more copies each time) | `mod.open` toggles |
| Title-bar button | yes | no (key, palette, close button) | no | no |
| State survives hiding | yes | **yes** | per pane | while open |
| Install work | clone layout + clone `tabs` + edit both | clone layout + insert block + key | key only | key only |

---

## 3. Recommendation

Use **A2**: the Source Control panel is a block in a personal layout, its own hidden column
`git-workbench` beside the Files/Changes `panel`, shown and hidden with `layout.toggle` from a key
binding and from the panel's close button. Keep **B** (`pane.split` with the mod) as the fallback
for people who stay on the shipped layout. Do not add a title-bar button: it needs a frozen clone of
the shipped `tabs` mod. Reject the kept window.

## 4. What installing the mod has to do

1. **Copy** the mod folder to `~/.config/herdr-app/mods/herdr-app-git-workbench/` as a real folder,
   not a junction (#10).
2. **Set `"place": "none"` in `mod.json`.** The install puts the block where it belongs. With
   `"right"`, Herdr would also auto-dock a second copy the first time a personal layout shows
   (see 1.5), and on the shipped layout the setting does nothing.
3. **Pick the layout.** If `shared("layout")` names a personal layout, use it. If it is a shipped
   one (`main`, `terminals`, `win98`), ask, then run `layout.clone {name: "main", as: "<name>"}`.
   That switches to the clone. Tell the person that the clone does not get later changes to `main`,
   and that `ctrl-shift-l` switches back.
4. **Insert the block** `git-workbench` (2.2, A2) into the clone's `work-body` row after `panel`,
   with `layout.set {layout}`. Do not insert it twice: check for the id first.
5. **Merge `keys.json`**: add `"ctrl-shift-g": "layout.toggle:git-workbench"` (or in a
   `layout:<name>` section). Ask before taking a key the person already uses. Note for the README:
   any edit makes the whole `keys.json` the person's, and later default shortcuts are no longer added
   (`AGENTS.md:517-519`).
6. **Run** `herdr-app check` on the folder.

Steps 3 to 5 can be done by the mod itself: `herdr-app do mod.open
'{"name":"herdr-app-git-workbench"}'` opens it as an overlay. With no `props().view`, it shows a
one-time "Add to layout" view that does steps 3 and 4 with `run()` and shows the key for step 5
(a mod cannot write `keys.json` with `run()`; the setup view can tell the person what to add, or
the README can). This also works for a person who installs from herdr.dev/mods, where the agent
"copies the mod folder and merges its `keys.json`" (`AGENTS.md:461-486`).

## 5. Open points

- The experiment in 1.6. It confirms the root cause and shows where Herdr's own dock lands.
- Whether the palette lists mod commands (`<mod>.<command>`). The docs say it lists "every
  command by name"; from `herdr-app commands` it seems to list app commands only. It does not
  change the recommendation.
- This machine: the Workbench is still unseen. When the person first shows a personal layout,
  Herdr will probably auto-dock it there. Set `"place": "none"` in the repo's `mod.json` before that
  happens, or remove the extra block afterwards.
