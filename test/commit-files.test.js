// @ts-check
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cleanup, initRepo, tempDir, git, write, png, docOf } from "./helpers/repo.js";
import { createWorkbench } from "../src/core/workbench.js";
import { nodePlatform } from "../src/adapters/node-platform.js";

after(cleanup);

/** @param {string} folder @param {import("../src/core/platform.js").Platform} [platform] */
async function follow(folder, platform = nodePlatform) {
  const workbench = createWorkbench(platform);
  await workbench.follow({ machine: null, folder });
  assert.equal(workbench.state.kind, "ready");
  return { workbench, repository: /** @type {any} */ (workbench.state).repository };
}

/** Loads the Graph and returns its commits by subject. */
async function commitsOf(repository) {
  await repository.graph.load();
  const state = repository.graph.state;
  assert.equal(state.kind, "ready", JSON.stringify(state));
  return Object.fromEntries(state.commits.map((/** @type {any} */ c) => [c.subject, c]));
}

/** Expands a commit and returns its loaded files, which must be ready. */
async function expandFiles(repository, oid) {
  await repository.graph.expand(oid);
  assert.equal(repository.graph.isExpanded(oid), true);
  const files = repository.graph.files(oid);
  assert.equal(files?.kind, "ready", JSON.stringify(files));
  return files.files;
}

test("expanding a commit lists its modified, added, deleted and renamed files", async () => {
  const root = initRepo({ files: { "keep.txt": "keep\n", "gone.txt": "gone\n", "dir/old.txt": "same content for rename\nline two\nline three\n" } });
  write(root, "keep.txt", "changed\n");
  write(root, "new.txt", "new\n");
  git(root, "rm", "-q", "gone.txt");
  git(root, "mv", "dir/old.txt", "dir/moved.txt");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "Mixed");
  const { repository } = await follow(root);
  const { Mixed } = await commitsOf(repository);

  const files = await expandFiles(repository, Mixed.oid);
  assert.deepEqual(files, [
    { status: "R", path: "dir/moved.txt", oldPath: "dir/old.txt" },
    { status: "D", path: "gone.txt" },
    { status: "M", path: "keep.txt" },
    { status: "A", path: "new.txt" },
  ]);
});

/** Expands `commit`, then opens its file at `file` in a Diff view: the target and its loaded document. */
async function openFile(workbench, repository, commit, file) {
  const f = (await expandFiles(repository, commit.oid)).find((/** @type {any} */ x) => x.path === file);
  assert.ok(f, `no file ${file}`);
  const target = repository.graph.fileTarget(commit.oid, f);
  assert.ok(target, `no target for ${file}`);
  return { target, doc: docOf(await workbench.loadDiff(target)) };
}

/** A compact picture of a split row. */
const pic = (/** @type {any} */ r) => `${r.kind} ${r.left ? `${r.left.line}:${r.left.text}` : "-"} | ${r.right ? `${r.right.line}:${r.right.text}` : "-"}`;

test("a commit file opens a Diff view from the first parent to the commit", async () => {
  const root = initRepo({ files: { "a.txt": "one\ntwo\n", "dir/old.txt": "same content for rename\nline two\nline three\n" } });
  write(root, "a.txt", "one\n2\n");
  git(root, "mv", "dir/old.txt", "dir/new.txt");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "Edit");
  write(root, "a.txt", "worktree edit\n"); // never read for a commit diff
  const { workbench, repository } = await follow(root);
  const { Edit, Initial } = await commitsOf(repository);

  const { target, doc } = await openFile(workbench, repository, Edit, "a.txt");
  assert.equal(target.left, Initial.oid);
  assert.equal(target.right, Edit.oid);
  assert.equal(target.group, "commit");
  assert.deepEqual(doc.rows("split").map(pic), ["ctx 1:one | 1:one", "mod 2:two | 2:2"]);

  const renamed = await openFile(workbench, repository, Edit, "dir/new.txt");
  assert.equal(renamed.target.oldPath, "dir/old.txt");
  assert.equal(renamed.doc.renameFrom, "dir/old.txt");
  assert.equal(renamed.doc.adds + renamed.doc.dels, 0);
});

test("a root commit's file is compared with empty content, not the worktree", async () => {
  const root = initRepo({ files: { "a.txt": "first\n" } });
  write(root, "a.txt", "worktree edit\n");
  const { workbench, repository } = await follow(root);
  const { Initial } = await commitsOf(repository);

  const { target, doc } = await openFile(workbench, repository, Initial, "a.txt");
  assert.equal(target.left, "EMPTY");
  assert.deepEqual(doc.rows("split").map(pic), ["add - | 1:first"]);
  assert.equal(doc.notice, "New file");
});

test("a shallow boundary commit is diffed as a root", async () => {
  const origin = initRepo({ files: { "a.txt": "1\n" } });
  for (const n of [2, 3]) {
    write(origin, "a.txt", `${n}\n`);
    git(origin, "commit", "-q", "-am", `Commit ${n}`);
  }
  const root = tempDir("gitwb-shallow-");
  git(root, "clone", "-q", "--depth", "2", pathToFileURL(origin).href, ".");
  const { workbench, repository } = await follow(root);
  const boundary = (await commitsOf(repository))["Commit 2"];

  const { target, doc } = await openFile(workbench, repository, boundary, "a.txt");
  assert.equal(target.left, "EMPTY");
  assert.deepEqual(doc.rows("split").map(pic), ["add - | 1:2"]);
});

test("deleted and binary commit files render in the Diff view", async () => {
  const root = initRepo({ files: { "gone.txt": "bye\n", "img.png": png(1) } });
  git(root, "rm", "-q", "gone.txt");
  write(root, "img.png", png(2));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "Change");
  const { workbench, repository } = await follow(root);
  const { Change } = await commitsOf(repository);

  const gone = await openFile(workbench, repository, Change, "gone.txt");
  assert.equal(gone.doc.deleted, true);
  assert.deepEqual(gone.doc.rows("split").map(pic), ["del 1:bye | -"]);

  const img = await openFile(workbench, repository, Change, "img.png");
  assert.equal(img.doc.binary, true);
});

test("a merge commit's file is compared with its first parent", async () => {
  const root = initRepo({ files: { "base.txt": "base\n" } });
  git(root, "checkout", "-q", "-b", "side");
  write(root, "side.txt", "side\n");
  git(root, "add", "side.txt");
  git(root, "commit", "-q", "-m", "Side");
  git(root, "checkout", "-q", "main");
  write(root, "main.txt", "main\n");
  git(root, "add", "main.txt");
  git(root, "commit", "-q", "-m", "Main");
  git(root, "merge", "-q", "--no-ff", "-m", "Merge side", "side");
  const { workbench, repository } = await follow(root);
  const commits = await commitsOf(repository);

  const { target, doc } = await openFile(workbench, repository, commits["Merge side"], "side.txt");
  assert.equal(target.left, commits.Main.oid);
  assert.deepEqual(doc.rows("split").map(pic), ["add - | 1:side"]);
});

test("a root commit lists all its files as added", async () => {
  const root = initRepo({ files: { "a.txt": "a\n", "sub/b.txt": "b\n" } });
  const { repository } = await follow(root);
  const { Initial } = await commitsOf(repository);

  assert.deepEqual(await expandFiles(repository, Initial.oid), [
    { status: "A", path: "a.txt" },
    { status: "A", path: "sub/b.txt" },
  ]);
});

test("a merge commit lists what it brought in against its first parent", async () => {
  const root = initRepo({ files: { "base.txt": "base\n" } });
  git(root, "checkout", "-q", "-b", "side");
  write(root, "side.txt", "side\n");
  git(root, "add", "side.txt");
  git(root, "commit", "-q", "-m", "Side");
  git(root, "checkout", "-q", "main");
  write(root, "main.txt", "main\n");
  git(root, "add", "main.txt");
  git(root, "commit", "-q", "-m", "Main");
  git(root, "merge", "-q", "--no-ff", "-m", "Merge side", "side");
  const { repository } = await follow(root);
  const commits = await commitsOf(repository);

  assert.deepEqual(await expandFiles(repository, commits["Merge side"].oid), [{ status: "A", path: "side.txt" }]);
});

test("unicode and space-containing paths come through unchanged", async () => {
  const root = initRepo();
  write(root, "dossier été/ünï cødé ✓.txt", "x\n");
  write(root, "with space.txt", "y\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "Names");
  const { repository } = await follow(root);
  const { Names } = await commitsOf(repository);

  assert.deepEqual(await expandFiles(repository, Names.oid), [
    { status: "A", path: "dossier été/ünï cødé ✓.txt" },
    { status: "A", path: "with space.txt" },
  ]);
});

test("clicking again collapses, and a second expand runs no git", async () => {
  const root = initRepo();
  let calls = 0;
  const counting = { ...nodePlatform, exec: (/** @type {any[]} */ ...a) => (calls++, nodePlatform.exec(...a)) };
  const { repository } = await follow(root, /** @type {any} */ (counting));
  const { Initial } = await commitsOf(repository);
  await expandFiles(repository, Initial.oid);

  await repository.graph.toggle(Initial.oid);
  assert.equal(repository.graph.isExpanded(Initial.oid), false);
  assert.deepEqual([...repository.graph.expanded], []);

  const before = calls;
  await repository.graph.toggle(Initial.oid);
  assert.equal(repository.graph.files(Initial.oid)?.kind, "ready");
  assert.equal(calls, before);
  assert.deepEqual([...repository.graph.expanded], [Initial.oid]);
});

test("a failing tree diff shows inside that commit only, and the rest of the Graph keeps working", async () => {
  const root = initRepo({ files: { "a.txt": "a\n" } });
  write(root, "b.txt", "b\n");
  git(root, "add", "b.txt");
  git(root, "commit", "-q", "-m", "Second");
  // Lose the second commit's tree: history still reads, its tree diff can't.
  const tree = git(root, "rev-parse", "HEAD^{tree}").trim();
  const object = path.join(root, ".git", "objects", tree.slice(0, 2), tree.slice(2));
  fs.chmodSync(object, 0o666);
  fs.rmSync(object);
  const { repository } = await follow(root);
  const { Second, Initial } = await commitsOf(repository);

  await repository.graph.toggle(Second.oid);
  assert.equal(repository.graph.isExpanded(Second.oid), true);
  const failed = repository.graph.files(Second.oid);
  assert.equal(failed?.kind, "error");
  assert.ok(failed.error.summary.length > 0);
  assert.equal(repository.graph.state.kind, "ready");

  assert.deepEqual(await expandFiles(repository, Initial.oid), [{ status: "A", path: "a.txt" }]);
});
