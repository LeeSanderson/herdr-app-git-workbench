import { test } from "node:test";
import assert from "node:assert/strict";
import { watchLabel } from "../mods/herdr-app-git-workbench/src/core/watch-filter.js";

const local = { root: "C:/Repo", gitDir: "C:/Repo/.git", commonDir: "C:/Repo/.git" };
const linked = { root: "C:/Wt", gitDir: "C:/Repo/.git/worktrees/wt", commonDir: "C:/Repo/.git" };

test("Windows verbatim paths (as Herdr's watchFolder reports them) match Git's paths", () => {
  assert.equal(watchLabel("\\\\?\\C:\\Repo\\a.txt", local), "worktree");
  assert.equal(watchLabel("\\\\?\\c:\\repo\\.git\\index", local), "worktree");
  assert.equal(watchLabel("\\\\?\\C:\\Repo\\.git\\index.lock", local), null);
  assert.equal(watchLabel("\\\\?\\C:\\Elsewhere\\a.txt", local), null);
});

test("verbatim UNC paths match Git's //server/share paths", () => {
  const unc = { root: "//srv/share/repo", gitDir: "//srv/share/repo/.git", commonDir: "//srv/share/repo/.git" };
  assert.equal(watchLabel("\\\\?\\UNC\\srv\\share\\repo\\a.txt", unc), "worktree");
  assert.equal(watchLabel("\\\\srv\\share\\repo\\a.txt", unc), "worktree");
});

test("working-tree files and the git dir's status files are worktree paths", () => {
  for (const p of ["C:/Repo/src/a.js", "C:/Repo/.git/index", "C:/Repo/.git/MERGE_HEAD", "C:/Repo/.git/rebase-merge/head-name"]) {
    assert.equal(watchLabel(p, local), "worktree", p);
  }
});

test("HEAD, loose refs, packed refs and reftable are refs paths", () => {
  for (const p of [
    "C:/Repo/.git/HEAD",
    "C:/Repo/.git/refs/heads/main",
    "C:/Repo/.git/refs/remotes/origin/main",
    "C:/Repo/.git/refs/tags/v1",
    "C:/Repo/.git/packed-refs",
    "C:/Repo/.git/reftable/tables.list",
    "C:/Repo/.git/reftable/0x000000000001-0x000000000002-1a2b3c4d.ref",
  ]) {
    assert.equal(watchLabel(p, local), "refs", p);
  }
});

test("a linked worktree's HEAD and reftable are refs paths; other worktrees' are ignored", () => {
  assert.equal(watchLabel("C:/Repo/.git/worktrees/wt/HEAD", linked), "refs");
  assert.equal(watchLabel("C:/Repo/.git/worktrees/wt/reftable/tables.list", linked), "refs");
  assert.equal(watchLabel("C:/Repo/.git/worktrees/wt/index", linked), "worktree");
  assert.equal(watchLabel("C:/Repo/.git/refs/heads/main", linked), "refs");
  assert.equal(watchLabel("C:/Repo/.git/worktrees/other/HEAD", linked), null);
  assert.equal(watchLabel("C:/Repo/.git/HEAD", linked), null);
});

// Git writes `<name>.lock` and renames it into place. A watcher may report only the
// lock name, so a lock under the Refs paths counts as `refs` (the debounce absorbs
// the extra event); other lock files are ignored.
test("lock files under the Refs paths are refs", () => {
  for (const p of [
    "C:/Repo/.git/HEAD.lock",
    "C:/Repo/.git/refs/heads/main.lock",
    "C:/Repo/.git/packed-refs.lock",
    "C:/Repo/.git/reftable/tables.list.lock",
  ]) {
    assert.equal(watchLabel(p, local), "refs", p);
  }
});

test("other lock files are ignored", () => {
  for (const p of ["C:/Repo/.git/index.lock", "C:/Repo/.git/config.lock", "C:/Repo/.git/MERGE_HEAD.lock"]) {
    assert.equal(watchLabel(p, local), null, p);
  }
});

test("objects, logs and FETCH_HEAD are ignored", () => {
  for (const p of ["C:/Repo/.git/objects/ab/cdef", "C:/Repo/.git/logs/HEAD", "C:/Repo/.git/logs/refs/heads/main", "C:/Repo/.git/FETCH_HEAD"]) {
    assert.equal(watchLabel(p, local), null, p);
  }
});
