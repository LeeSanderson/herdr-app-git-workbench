# Herdr App Git Workbench

**Repository:** `herdr-app-git-workbench`  
**Mod identifier:** `herdr-app-git-workbench`  
**Display name:** Git Workbench  
**Description:** Git source control, history and visual diff tools for Herdr Desktop.

## 1. Objective

Create a native Herdr Desktop mod providing a comprehensive Git experience inspired by:

- Visual Studio Code's Source Control panel and diff editor.
- The functionality and UX of the original [herdr-sidebar TUI plugin](https://github.com/alexarthurs/herdr-sidebar).

The objective is to make everyday Git operations, repository exploration and code review possible without leaving Herdr or switching to an external editor.

**Target platform:** Windows initially, with an architecture that allows Linux and macOS support.

**Target application:** Herdr Desktop (`herdr-app`), not Herdr TUI.

## 2. User interface

Provide a dockable Git Workbench panel with two primary views, accessible through an activity bar or tabs.

### 2.1 Source Control

Display:

- Current branch and upstream tracking status.
- Ahead/behind commit counts.
- Staged Changes.
- Changes (unstaged).
- Untracked Files.
- Merge conflicts.
- File status indicators (modified, added, deleted, renamed, untracked).

Support:

- Stage and unstage individual files.
- Stage and unstage all changes.
- Discard individual file changes, with confirmation.
- Commit staged changes with a commit message.
- Amend the previous commit.
- Fetch, pull and push (from the Graph toolbar, §2.3).
- Refresh repository status.

### 2.2 Diff Editor

Selecting a changed file opens a dedicated diff editor.

Provide:

- Side-by-side and inline diff modes.
- Syntax highlighting.
- Line numbers.
- Added, removed and modified line highlighting.
- Synchronized scrolling between panes.
- Navigation between changed sections.
- Clear indication of the file being compared and its Git status.
- Support for staged versus unstaged changes.
- Support for new, deleted and renamed files.

The diff editor should be a proper code-review experience, not simply display the output of `git diff` in a terminal.

Allow diffs to be opened in a separate Herdr pane and retain the ability to switch between multiple open files.

### 2.3 Graph

A collapsible **Graph** section inside the Source Control panel, below the Change groups. It is modelled on the Graph in VS Code's Source Control view.

Display:

- Commits reachable from the selected Refs, newest first in topological order, drawn with coloured lanes showing how each commit joins its parents. HEAD has a ringed dot, merge commits a hollow dot, and other commits a filled dot.
- Two lines per commit. Line 1 shows the Ref badges and the subject (bold for HEAD). Line 2 shows the short oid, the author, a relative date, and a `merge` marker on merge commits.
- Ref badges for HEAD, local branches, remote branches and tags, up to three per commit and then `+N`.
- The first 50 commits, with a **Load more…** row that adds 50 more each time. "No commits yet" in an empty repository.

Support:

- Expanding a commit to show its details (full oid, author and email, date, parents, full message) and its changed files with status letters (M, A, D, R).
- Opening a changed file in a Diff view, comparing the commit with its first parent (a root commit is compared with empty content).
- A **Ref filter**: **Auto** (HEAD and its Upstream, the default), **All** (every branch, remote branch and tag) or **Current** (HEAD only), remembered per Repository.
- Toolbar actions: go to current, refresh, **Fetch**, **Pull ↓n**, and **Push ↑n**. Push becomes **Publish** when the branch has no Upstream.
- Keyboard navigation of commits and files, with Tab moving focus between the Change list, the commit box and the Graph.
- A draggable divider between the Change groups and the Graph. The Graph takes up to two thirds of the panel by default.

Behaviour:

- The Graph reloads when HEAD or any Ref changes (inside or outside Herdr), after every Workbench Git operation, and on refresh. It never polls. A reload keeps expanded commits, the selection and the scroll position.
- Pull follows the user's `pull.rebase` / `pull.ff` configuration. When neither is set, it fast-forwards only, and if the branches have diverged it offers a one-off merge or rebase. It never stashes automatically. A pull that stops with Conflicts hands over to the Conflicts group.
- Push never forces. A rejected push suggests pulling first.
- Sign-in is left to Git and its credential helper. When sign-in fails, the Workbench reports it clearly.

Not in the Graph: commit actions that change history (checkout, create branch, cherry-pick, revert, reset), file history, a row for uncommitted changes, background auto-fetch, and Abort/Continue controls for a stopped merge or rebase.

## 3. Git integration

Use the locally installed Git executable through Herdr Desktop's native `exec()` API.

Use Git as the source of truth rather than implementing Git operations independently.

Initially support a single repository associated with the active Herdr workspace. Design the implementation to accommodate multiple repositories later.

Use repository-relative paths and handle Windows paths, spaces and Unicode correctly.

Refresh repository state when relevant files change, when Git operations complete and when the user explicitly requests a refresh.

Avoid unnecessarily frequent polling.

## 4. Implementation details

### 4.1 Git command execution

Create a dedicated Git service responsible for executing Git commands and returning structured results to the rest of the application.

- Use Herdr's native `exec()` API.
- Execute Git directly, without passing commands through PowerShell, `cmd.exe` or shell scripts.
- Pass arguments separately wherever the API permits.
- Set the working directory explicitly to the repository root.
- Capture standard output, standard error and exit codes.
- Handle asynchronous execution without blocking the UI.
- Apply sensible timeouts to operations that might hang.
- Prevent concurrent operations from corrupting repository state.

Do not construct shell commands by concatenating user-controlled values, particularly file paths and commit messages.

### 4.2 Repository status

Use:

```bash
git status --porcelain=v2 -z --branch
```

This provides machine-readable status information and avoids relying on Git's human-readable output.

Parse the output into a structured repository model containing:

- Branch and upstream information.
- Ahead/behind counts.
- Staged changes.
- Unstaged changes.
- Untracked files.
- Renamed and copied files.
- Merge conflicts.

Use NUL-delimited parsing rather than splitting output on newlines. This is important because valid Git filenames can contain spaces, quotes and newlines.

Represent file changes using a common internal model, for example:

```javascript
{
  path: "src/example.cs",
  originalPath: null,
  indexStatus: "M",
  workTreeStatus: " ",
  isUntracked: false,
  isConflict: false
}
```

The model should preserve the distinction between index (staged) and working-tree (unstaged) changes.

### 4.3 Diff generation

Use Git to generate the actual differences rather than attempting to derive them by comparing file contents independently.

Useful commands include:

```bash
# Unstaged changes
git diff --no-ext-diff --no-color

# Staged changes
git diff --cached --no-ext-diff --no-color

# Specific file
git diff -- src/example.cs

# Compare a file against HEAD
git show HEAD:src/example.cs
```

For a selected file, generate the appropriate comparison depending on its state:

| State | Comparison |
|---|---|
| Unstaged modification | Index versus working tree |
| Staged modification | HEAD versus index |
| Untracked file | Empty content versus working tree |
| Deleted file | Previous content versus empty content |
| New staged file | Empty content versus index |
| Renamed file | Original path versus new path |

Parse unified diff output into structured hunks and line changes.

The diff model should contain:

- Old and new file paths.
- Old and new line numbers.
- Change type (addition, deletion, context).
- Hunk boundaries.
- File metadata.
- Binary-file indication.

Use this model to render both inline and side-by-side views.

Do not attempt to render binary files as text. Display an appropriate binary-file message instead.

### 4.4 Staging and Git operations

Use native Git commands for all modifications:

```bash
# Stage a file
git add -- src/example.cs

# Unstage a file
git restore --staged -- src/example.cs

# Discard working-tree changes
git restore --worktree -- src/example.cs

# Commit staged changes
git commit -m "Commit message"
```

For file paths, use the appropriate argument handling and `--` separator to prevent paths being interpreted as Git options.

Implement operations individually, with appropriate success and failure feedback.

Discard operations must require confirmation.

Hunk-level staging can be added later using `git apply --cached` with generated patch content. Ensure patches include the correct file headers and line offsets.

### 4.5 Diff editor implementation

Use Herdr's native code editor component (`EditorState` / `Editor`) where appropriate.

Keep diff generation independent of rendering.

Implement a dedicated diff presentation layer that:

- Renders additions, deletions and unchanged lines.
- Supports inline and side-by-side modes.
- Maintains corresponding scroll positions between panes.
- Supports navigation between hunks.
- Provides syntax highlighting based on file extension.
- Handles long lines and large files without making the interface unresponsive.

Investigate whether Herdr's editor component supports read-only mode and line decorations. If it does not, implement a lightweight native diff view using GPUI components.

Do not introduce a browser-based editor or WebView.

### 4.6 State management and refresh

Maintain a central repository state model.

The UI should react to changes in repository state rather than independently executing Git commands from individual components.

Refresh repository state:

- On initial mod activation.
- After Git operations.
- When the user requests a refresh.
- When filesystem changes are detected.

Use filesystem watching where supported, with a debounced refresh to avoid repeated Git invocations during bulk changes.

Avoid watching the `.git` directory indiscriminately.

Handle Git operations initiated outside Herdr by detecting relevant filesystem changes or providing periodic background refresh as a fallback.

### 4.7 Windows considerations

Windows is the initial target platform, so explicitly account for:

- Git for Windows installation and executable discovery.
- Windows path separators and drive letters.
- Spaces and Unicode in paths.
- Windows file locking and access restrictions.
- Long-running Git operations.
- CRLF versus LF line endings.
- Case-insensitive filesystem behaviour.
- Repository paths containing special characters.

Do not assume Git is available on the system PATH without checking.

### 4.8 Error handling and safety

- Never silently discard user changes.
- Never automatically stage files.
- Never commit without explicit user action.
- Clearly report Git errors.
- Handle repositories with merge conflicts.
- Handle repositories with no commits.
- Handle missing or invalid repositories.
- Avoid loading entire large files into memory unnecessarily.
- Do not execute Git hooks or other repository-provided scripts without the normal Git operation and its associated user expectations.

## 5. Technical architecture

Implement as a native Herdr Desktop mod using:

- JavaScript.
- Herdr's `gpui-kit` UI components.
- Herdr's native `exec()` API for Git operations.
- Herdr's file APIs and folder watching where appropriate.
- Herdr's theme API for colours and styling.

Use a modular architecture:

```text
herdr-app-git-workbench/
├── mod.json
├── main.js
├── src/
│   ├── git/
│   │   ├── git-client.js
│   │   ├── repository.js
│   │   ├── status-parser.js
│   │   ├── diff-parser.js
│   │   └── git-operations.js
│   ├── state/
│   │   └── repository-state.js
│   └── ui/
│       ├── source-control.js
│       ├── changes-list.js
│       ├── diff-editor.js
│       └── commit-history.js
└── README.md
```

The structure is illustrative. Adapt it to the conventions and module-loading capabilities of Herdr Desktop.

Keep Git execution, repository state management and UI rendering logically separated.

Use asynchronous execution for Git operations and ensure the interface remains responsive.

## 6. Scope and priorities

### MVP

1. Repository detection and Git status.
2. Staged, unstaged and untracked file lists.
3. Stage, unstage and discard.
4. Side-by-side and inline file diffs.
5. Commit staged changes.
6. Branch information and refresh.

### Subsequent enhancements

- The Graph (§2.3): commit history, commit details, Ref badges and fetch/pull/push synchronisation.
- File history.
- Branch switching and creation.
- Commit actions from the Graph (checkout, create branch, cherry-pick, revert, reset).
- Abort/Continue controls for a stopped merge or rebase.
- Background auto-fetch.
- Hunk-level staging and unstaging.
- Amend commits.
- Multiple repository support.
- Worktrees and stash management.

Do not include AI-generated commit messages in the MVP.

## 7. Acceptance criteria

- Works in Herdr Desktop on Windows.
- Does not require the Herdr TUI or its plugin system.
- Detects the repository associated with the active workspace.
- Correctly distinguishes staged, unstaged and untracked changes.
- Git operations produce the expected results in the underlying repository.
- Diff views correctly represent staged and unstaged changes.
- Handles binary files, renamed files and deleted files gracefully.
- UI follows the current Herdr theme.
- No external editor or terminal is required for the core workflow.

## 8. Herdr terminology and extension systems

There are two distinct extension systems.

### Herdr TUI plugins

- Used by the original terminal-based Herdr application.
- Installed using `herdr plugin install`.
- Can be implemented in Rust or other executable languages.
- Example: [alexarthurs/herdr-sidebar](https://github.com/alexarthurs/herdr-sidebar).
- This is a reference for functionality and UX, not a compatible implementation.

### Herdr Desktop mods

- Used by the graphical Herdr application (`herdr-app`).
- Written in JavaScript using GPUI components.
- Stored in the Herdr app home under `mods/<name>/`.
- Typically contain `main.js` and an optional `mod.json`.
- Reload automatically when files are saved.

The desktop application also uses `herdr-core` (`hc`) for terminal and agent management. Neither `hc` nor the original `herdr` TUI CLI is the desktop mod runtime.

**Do not use `herdr plugin install` to install this mod.**

## 9. Development, testing and deployment

### Development

- Develop directly in a personal mod directory.
- Use Herdr's hot reload while developing.
- Use the installed version's generated `herdr.d.ts` and `gpui-kit.d.ts` as the authoritative API references.
- Prefer those over examples written for a different release.

### Testing

- Run `herdr-app check` after each significant change.
- Test the actual UI in the running desktop application.
- Use `herdr-app status` to inspect runtime errors.
- Use `herdr-app shot` to capture screenshots for visual verification.
- Test Git operations against temporary repositories containing staged, unstaged, untracked, renamed and deleted files.
- Include tests for filenames containing spaces, Unicode and unusual characters.
- Test repositories with merge conflicts and no commits.
- Test against both CRLF and LF line endings.
- Test large files and binary files.

### Deployment and publishing

- Deploy by packaging the mod directory and installing it under the user's Herdr app home.
- Publish the mod in a public GitHub repository named `herdr-app-git-workbench`.
- Use the `herdr-mod` GitHub topic for discoverability.
- Include a `README.md`, `RECIPE.md` and `preview.png`.
- Document installation, configuration, supported platforms and known limitations.

The mod should not require compiling or rebuilding Herdr itself.

## 10. Documentation and references

### Herdr Desktop mod development

- [Layouts and Mods documentation](https://github.com/herdrdev/herdr-app/blob/master/docs/mods.md)
- [Complete mod development guide (AGENTS.md)](https://github.com/herdrdev/herdr-app/blob/master/defaults/AGENTS.md)
- [GPUI Kit documentation](https://gpui-kit.com)

### Building and testing

- [Mod structure, API, lifecycle and hot reload](https://github.com/herdrdev/herdr-app/blob/master/defaults/AGENTS.md)
- [Mod validation with `herdr-app check`](https://github.com/herdrdev/herdr-app/blob/master/docs/mods.md)
- [Herdr Desktop repository and CLI documentation](https://github.com/herdrdev/herdr-app)

### Deployment and sharing

- [Herdr Gallery](https://herdr.dev/gallery/)
- [Herdr Desktop security and privacy](https://github.com/herdrdev/herdr-app/blob/master/docs/security.md)

The installed version's generated `herdr.d.ts` and `gpui-kit.d.ts` are the authoritative API references for that version. Prefer those over examples written for a different release.
