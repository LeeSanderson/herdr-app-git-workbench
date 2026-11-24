import { test, after } from "node:test";
import assert from "node:assert/strict";
import { initRepo, git, write, lines, png, cleanup } from "./helpers/repo.js";
import { createGit } from "../src/core/git.js";
import { nodePlatform } from "../src/adapters/node-platform.js";
import { diffTargetFor } from "../src/core/diff-target.js";
import { loadDiff } from "../src/core/diff.js";
import { displaySegments } from "../src/core/display.js";

after(cleanup);

const gitRunner = createGit(nodePlatform);

/** Loads the DiffDocument for `change` in the repository at `root`. */
const load = (root, change) => loadDiff(gitRunner, diffTargetFor({ machine: null, toplevel: root }, change));

/** A compact picture of a split row: "kind L:text | R:text". */
const pic = (r) => `${r.kind} ${r.left ? `${r.left.line}:${r.left.text}` : "-"} | ${r.right ? `${r.right.line}:${r.right.text}` : "-"}`;

test("a binary file is detected and produces no rows", async () => {
  const root = initRepo({ files: { "img.png": png(1) } });
  write(root, "img.png", png(2));
  const doc = await load(root, { path: "img.png", status: "M", group: "changes" });
  assert.equal(doc.binary, true);
  assert.deepEqual(doc.rows("split"), []);
});

test("an untracked file is all additions against an empty left half, with a notice", async () => {
  const root = initRepo();
  write(root, "dir/u.txt", lines(["new", "file"]));
  const doc = await load(root, { path: "dir/u.txt", status: "A", group: "untracked" });
  assert.deepEqual(doc.rows("split").map(pic), ["add - | 1:new", "add - | 2:file"]);
  assert.equal(doc.added, true);
  assert.equal(doc.notice, "Untracked file: not yet tracked by Git");
});

test("a staged new file is all additions, with a notice", async () => {
  const root = initRepo();
  write(root, "n.txt", lines(["hello"]));
  git(root, "add", "n.txt");
  const doc = await load(root, { path: "n.txt", status: "A", group: "staged" });
  assert.deepEqual(doc.rows("split").map(pic), ["add - | 1:hello"]);
  assert.equal(doc.added, true);
  assert.equal(doc.notice, "New file");
});

test("a deleted file is all deletions against an empty right half, with a notice", async () => {
  const root = initRepo({ files: { "d.txt": lines(["one", "two"]) } });
  git(root, "rm", "-q", "--cached", "d.txt");
  const staged = await load(root, { path: "d.txt", status: "D", group: "staged" });
  assert.deepEqual(staged.rows("split").map(pic), ["del 1:one | -", "del 2:two | -"]);
  assert.equal(staged.deleted, true);
  assert.equal(staged.notice, "Deleted file");

  const root2 = initRepo({ files: { "d.txt": lines(["one"]) } });
  git(root2, "rm", "-q", "d.txt");
  git(root2, "reset", "-q", "--", "d.txt");
  const unstaged = await load(root2, { path: "d.txt", status: "D", group: "changes" });
  assert.deepEqual(unstaged.rows("split").map(pic), ["del 1:one | -"]);
  assert.equal(unstaged.notice, "Deleted file");
});

test("a binary file gets the Binary file changed notice", async () => {
  const root = initRepo();
  write(root, "img.png", png(3));
  const doc = await load(root, { path: "img.png", status: "A", group: "untracked" });
  assert.equal(doc.binary, true);
  assert.equal(doc.notice, "Binary file changed · Untracked file: not yet tracked by Git");
});

test("a mode-only change has no rows and a notice naming both modes", async () => {
  const root = initRepo({ files: { "run.sh": lines(["echo hi"]) } });
  git(root, "update-index", "--chmod=+x", "run.sh");
  const doc = await load(root, { path: "run.sh", status: "M", group: "staged" });
  assert.deepEqual(doc.rows("split"), []);
  assert.equal(doc.notice, "Mode changed 100644 → 100755");
});

test("a staged rename carries the old path and similarity for the header", async () => {
  const root = initRepo({ files: { "src/old name.txt": lines(["a", "b", "c", "d"]) } });
  git(root, "rm", "-q", "src/old name.txt");
  write(root, "lib/new.txt", lines(["a", "b", "c", "D"]));
  git(root, "add", "lib/new.txt");
  const doc = await load(root, { path: "lib/new.txt", oldPath: "src/old name.txt", status: "R", group: "staged" });
  assert.equal(doc.renameFrom, "src/old name.txt");
  assert.equal(doc.similarity, 75);
  assert.equal(doc.notice, null);
  assert.deepEqual(doc.rows("split").map(pic), ["ctx 1:a | 1:a", "ctx 2:b | 2:b", "ctx 3:c | 3:c", "mod 4:d | 4:D"]);
});

test("a Conflict shows git's combined diff: HEAD's version on the left, the working tree with its markers on the right", async () => {
  const root = initRepo({ files: { "f.txt": lines(["top", "a", "end"]) } });
  git(root, "checkout", "-q", "-b", "other");
  write(root, "f.txt", lines(["top", "b", "end"]));
  git(root, "commit", "-q", "-am", "other");
  git(root, "checkout", "-q", "main");
  write(root, "f.txt", lines(["top", "c", "end"]));
  git(root, "commit", "-q", "-am", "main");
  assert.throws(() => git(root, "merge", "-q", "other"));
  const doc = await load(root, { path: "f.txt", status: "UU", group: "conflicts" });
  assert.equal(doc.combined, true);
  assert.deepEqual(doc.rows("split").map(pic), [
    "ctx 1:top | 1:top",
    "add - | 2:<<<<<<< HEAD",
    "ctx 2:c | 3:c",
    "add - | 4:=======",
    "add - | 5:b",
    "add - | 6:>>>>>>> other",
    "ctx 3:end | 7:end",
  ]);
  assert.equal(doc.adds, 4);
  assert.equal(doc.dels, 0);
  assert.equal(doc.notice, null);
});

test("a line-ending change from LF to CRLF keeps the CR in the text and marks it as the changed part", async () => {
  const root = initRepo({ files: { "a.txt": "one\ntwo\n" } });
  write(root, "a.txt", "one\r\ntwo\n");
  const rows = (await load(root, { path: "a.txt", status: "M", group: "changes" })).rows("split");
  assert.deepEqual(rows.map(pic), ["mod 1:one | 1:one\r", "ctx 2:two | 2:two"]);
  assert.deepEqual(rows[0].right.changed, [3, 4]);
  assert.deepEqual(displaySegments(rows[0].right.text, rows[0].right.changed), [{ s: "one", hl: false }, { s: "␍", hl: true }]);
});

test("tabs expand to 4-column stops, counted across highlighted parts", () => {
  assert.deepEqual(displaySegments("\tx\ty", undefined), [{ s: "    x   y", hl: false }]);
  assert.deepEqual(displaySegments("ab\tc\td", [3, 4]), [{ s: "ab  ", hl: false }, { s: "c", hl: true }, { s: "   d", hl: false }]);
});

/** Runs `git apply --cached --check` on `patch` in `root`; throws if git rejects it. */
function applyCachedCheck(root, patch) {
  const file = write(root, ".git/test.patch", patch);
  git(root, "apply", "--cached", "--check", file);
}

test("toPatch() of an unstaged change applies to the index, keeping CRLF, tabs and a missing final newline", async () => {
  const root = initRepo({ files: { "a.txt": "one\r\n\ttwo\r\nthree\nfour" } });
  write(root, "a.txt", "one\r\n\tTWO\r\nthree\nfour\nfive");
  const doc = await load(root, { path: "a.txt", status: "M", group: "changes" });
  const patch = doc.toPatch();
  assert.match(patch, /^diff --git a\/a.txt b\/a.txt\n/);
  assert.match(patch, /\n-\ttwo\r\n\+\tTWO\r\n/);
  assert.match(patch, /\n\\ No newline at end of file\n/);
  applyCachedCheck(root, patch);
});

test("toPatch() of a staged change applies once the change is unstaged", async () => {
  const root = initRepo({ files: { "a.txt": lines(["one", "two"]) } });
  write(root, "a.txt", lines(["one", "2"]));
  git(root, "add", "a.txt");
  const patch = (await load(root, { path: "a.txt", status: "M", group: "staged" })).toPatch();
  git(root, "reset", "-q", "--", "a.txt");
  applyCachedCheck(root, patch);
});

test("toPatch() of an untracked file and of a staged rename apply to the index", async () => {
  const root = initRepo({ files: { "old.txt": lines(["a", "b", "c", "d"]) } });
  write(root, "u.txt", lines(["new"]));
  applyCachedCheck(root, (await load(root, { path: "u.txt", status: "A", group: "untracked" })).toPatch());

  git(root, "mv", "old.txt", "new.txt");
  write(root, "new.txt", lines(["a", "b", "c", "D"]));
  git(root, "add", "new.txt");
  const patch = (await load(root, { path: "new.txt", oldPath: "old.txt", status: "R", group: "staged" })).toPatch();
  assert.match(patch, /\nrename from old.txt\nrename to new.txt\n/);
  git(root, "reset", "-q", "--", "old.txt", "new.txt");
  applyCachedCheck(root, patch);
});

test("a plain modification has no notice", async () => {
  const root = initRepo({ files: { "a.txt": lines(["one"]) } });
  write(root, "a.txt", lines(["two"]));
  const doc = await load(root, { path: "a.txt", status: "M", group: "changes" });
  assert.equal(doc.notice, null);
  assert.equal(doc.added, false);
  assert.equal(doc.deleted, false);
});
