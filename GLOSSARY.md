# Glossary

**Workbench**: The Git Workbench mod as a whole: the docked Source Control panel plus any open Diff views.

**Source Control panel**: The docked panel listing the Repository's Changes in Change groups, with branch information and the commit box.

**Diff view**: A read-only, code-review presentation of one Change, in either side-by-side or inline mode. Not raw `git diff` output.

**Repository**: The single Git repository the Workbench is following, resolved from the active Herdr space's folder.

**Change**: One path that differs between HEAD, the index and the working tree. A path can have a staged Change and an unstaged Change at the same time.

**Change group**: One of the four lists a Change appears in: **Staged**, **Changes** (unstaged), **Untracked**, **Conflicts**.

**Conflict**: A path left unmerged by a merge, rebase or cherry-pick. It is *marked resolved* by staging it; the Workbench never resolves its content.

**Diff target**: What a Diff view compares: one path (or an old and new path, for a rename) between two sides. Each side is a commit, HEAD, the index, the working tree, or empty.

**Operation in progress**: A merge, rebase, cherry-pick or revert that has stopped partway, usually leaving Conflicts.

**Linked worktree**: An additional working tree of a repository. Each one is a separate Repository to the Workbench, but they share history and branches with each other.

**Discard**: Throwing away a Change's working-tree modifications. It always requires the user to confirm.

**Graph**: The Source Control panel section listing commits reachable from the selected Refs, drawn with lanes showing how each commit connects to its parents.

**Ref**: A named pointer into history shown as a badge in the Graph: a local branch, a remote branch, a tag, or HEAD.

**Phase 1**: The MVP feature set. **Phase 2**: The follow-on feature set that Phase 1's design must not block.
