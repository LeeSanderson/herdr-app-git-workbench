// @ts-check
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cleanup, initRepo, unbornRepo, tempDir, git, write } from "./helpers/repo.js";
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

/** @param {string} root @param {string} file @param {string} content @param {string} [message] */
function commit(root, file, content, message = `edit ${file}`) {
  write(root, file, content);
  git(root, "add", "--", file);
  git(root, "commit", "-q", "-m", message);
}

/** Loads the Graph and returns its state, which must be ready. */
async function loaded(repository) {
  await repository.graph.load();
  const state = repository.graph.state;
  assert.equal(state.kind, "ready", JSON.stringify(state));
  return state;
}

test("the Graph lists commits newest first with their fields", async () => {
  const root = initRepo();
  git(root, "config", "user.name", "Zoë Ångström");
  git(root, "config", "user.email", "zoe@example.invalid");
  commit(root, "b.txt", "b\n", "Second ✓ línea\n\nBody line one\nBody line two ✓");
  const { repository } = await follow(root);

  const { commits } = await loaded(repository);
  assert.deepEqual(commits.map((c) => c.subject), ["Second ✓ línea", "Initial"]);
  const [second, initial] = commits;
  assert.equal(second.oid, git(root, "rev-parse", "HEAD").trim());
  assert.deepEqual(second.parents, [initial.oid]);
  assert.deepEqual(initial.parents, []);
  assert.equal(second.authorName, "Zoë Ångström");
  assert.equal(second.authorEmail, "zoe@example.invalid");
  assert.ok(!Number.isNaN(Date.parse(second.authorDate)), second.authorDate);
  assert.equal(second.message.trim(), "Second ✓ línea\n\nBody line one\nBody line two ✓");
});

test("an unborn HEAD runs no git and leaves the Graph empty", async () => {
  const root = unbornRepo();
  let calls = 0;
  const counting = { ...nodePlatform, exec: (/** @type {any[]} */ ...a) => (calls++, nodePlatform.exec(...a)) };
  const { repository } = await follow(root, /** @type {any} */ (counting));

  const before = calls;
  await repository.graph.load();
  assert.equal(calls, before);
  assert.equal(repository.graph.state.kind, "empty");
});

test("a shallow clone's boundary commit ends its lane without errors", async () => {
  const origin = initRepo();
  for (const n of [1, 2, 3]) commit(origin, "a.txt", `${n}\n`, `Commit ${n}`);
  const root = tempDir("gitwb-shallow-");
  git(root, "clone", "-q", "--depth", "2", pathToFileURL(origin).href, ".");
  const { repository } = await follow(root);

  const { commits, rows, hasMore } = await loaded(repository);
  assert.deepEqual(commits.map((c) => c.subject), ["Commit 3", "Commit 2"]);
  assert.equal(hasMore, false);
  assert.deepEqual(rows.at(-1).outgoing.filter((o) => o !== null), []);
});

test("the Graph shows the first 50 commits and says when there are more", async () => {
  const root = initRepo();
  for (let n = 1; n <= 51; n++) git(root, "commit", "-q", "--allow-empty", "-m", `Commit ${n}`);
  const { repository } = await follow(root);

  const { commits, rows, hasMore, head } = await loaded(repository);
  assert.equal(commits.length, 50);
  assert.equal(commits[0].subject, "Commit 51");
  assert.equal(hasMore, true);
  assert.deepEqual(rows.map((r) => r.oid), commits.map((c) => c.oid));
  assert.equal(head, commits[0].oid);
});

test("a failed load is an error with Retry, and the Change groups keep working", async () => {
  const root = initRepo({ files: { "a.txt": "a\n" } });
  commit(root, "a.txt", "b\n", "Second");
  // Lose the first commit's object: status still works, but history can't be read.
  const initial = git(root, "rev-parse", "HEAD~1").trim();
  const object = path.join(root, ".git", "objects", initial.slice(0, 2), initial.slice(2));
  const saved = fs.readFileSync(object);
  fs.chmodSync(object, 0o666);
  fs.rmSync(object);
  const { repository } = await follow(root);

  const loading = repository.graph.load();
  assert.equal(repository.snapshot.running, null, "a Graph load doesn't occupy the queue");
  await loading;
  const state = repository.graph.state;
  assert.equal(state.kind, "error");
  assert.ok(state.error.summary.length > 0);

  write(root, "new.txt", "new\n");
  await repository.refresh();
  assert.deepEqual(await repository.stage(["new.txt"]), { ok: true });
  assert.deepEqual(repository.snapshot.groups.staged.map((c) => c.path), ["new.txt"]);

  fs.writeFileSync(object, saved);
  const { commits } = await loaded(repository); // Retry
  assert.deepEqual(commits.map((c) => c.subject), ["Second", "Initial"]);
});

test("committing reloads a loaded Graph", async () => {
  const root = initRepo();
  const { repository } = await follow(root);
  await loaded(repository);

  write(root, "b.txt", "b\n");
  await repository.stage(["b.txt"]);
  const reloaded = new Promise((resolve) => repository.graph.subscribe(resolve));
  assert.deepEqual(await repository.commit({ message: "Add b" }), { ok: true });
  await reloaded;
  const state = repository.graph.state;
  assert.equal(state.kind, "ready");
  assert.deepEqual(state.commits.map((c) => c.subject), ["Add b", "Initial"]);
});

test("the selection survives a reload, and drops quietly once an amend rewrote its commit", async () => {
  const root = initRepo();
  commit(root, "b.txt", "b\n", "Second");
  const { repository } = await follow(root);
  const { commits, head } = await loaded(repository);
  const graph = repository.graph;
  const initial = commits[1].oid;

  graph.select({ oid: initial, path: "a.txt" });
  await loaded(repository);
  assert.deepEqual(graph.selection, { oid: initial, path: "a.txt" });

  graph.select({ oid: head, path: null });
  git(root, "commit", "-q", "--amend", "-m", "Second, amended");
  await loaded(repository);
  assert.equal(graph.selection, null);
});
