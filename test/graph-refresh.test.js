// @ts-check
// The Graph stays current: Ref changes reload it, file edits don't, and a reload
// keeps the loaded count and the expanded commits.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { cleanup, initRepo, git, write, tempDir } from "./helpers/repo.js";
import { createWorkbench } from "../src/core/workbench.js";
import { nodePlatform } from "../src/adapters/node-platform.js";
import { fakePlatform, followCounting, untilRefreshed, quiet, watchOf } from "./helpers/fake-platform.js";

after(cleanup);

/** @param {string} root @param {string} file @param {string} content @param {string} [message] */
function commit(root, file, content, message = `edit ${file}`) {
  write(root, file, content);
  git(root, "add", "--", file);
  git(root, "commit", "-q", "-m", message);
}

/** Counts Graph changes and resolves `next` on the next one. */
function watchGraph(graph) {
  const seen = { changes: 0 };
  graph.subscribe(() => seen.changes++);
  return seen;
}

/** Ticks the fake clock until `done()` holds (or gives up after ~15 s). */
async function until(fake, done) {
  for (let i = 0; i < 300 && !done(); i++) {
    await fake.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
}

const subjects = (graph) => (graph.state.kind === "ready" ? graph.state.commits.map((c) => c.subject) : graph.state.kind);

test("a commit made in a terminal reloads the Graph", async () => {
  const fake = fakePlatform();
  const root = initRepo();
  const { repository } = await followCounting(fake, root);
  await repository.graph.load();

  commit(root, "b.txt", "b\n", "From the terminal");
  const gitDir = path.join(root, ".git");
  watchOf(fake, root).fire([path.join(root, "b.txt"), path.join(gitDir, "index"), path.join(gitDir, "refs", "heads", "main"), path.join(gitDir, "logs", "HEAD")]);
  await until(fake, () => subjects(repository.graph)[0] === "From the terminal");

  assert.deepEqual(subjects(repository.graph), ["From the terminal", "Initial"]);
});

test("creating a branch in a terminal reloads the Graph", async () => {
  const fake = fakePlatform();
  const root = initRepo();
  const { repository } = await followCounting(fake, root);
  await repository.graph.load();

  git(root, "branch", "feature");
  watchOf(fake, root).fire([path.join(root, ".git", "refs", "heads", "feature")]);
  const badges = () => (repository.graph.state.kind === "ready" ? repository.graph.state.commits[0].badges.map((b) => b.name) : []);
  await until(fake, () => badges().includes("feature"));

  assert.deepEqual(badges(), ["main", "feature"]);
});

test("a file edit refreshes status but doesn't reload the Graph", async () => {
  const fake = fakePlatform();
  const root = initRepo();
  const counter = await followCounting(fake, root);
  const graph = counter.repository.graph;
  await graph.load();
  const seen = watchGraph(graph);

  write(root, "README.md", "edited\n");
  watchOf(fake, root).fire([path.join(root, "README.md"), path.join(root, ".git", "index")]);
  await untilRefreshed(fake, counter);
  await quiet(fake);

  assert.deepEqual(counter.repository.snapshot.groups.changes.map((c) => c.path), ["README.md"]);
  assert.equal(seen.changes, 0);
});

test("after an amend the old oid's expanded state is dropped and other expanded commits survive", async () => {
  const root = initRepo();
  commit(root, "b.txt", "b\n", "Second");
  commit(root, "c.txt", "c\n", "Third");
  const workbench = createWorkbench(nodePlatform);
  await workbench.follow({ machine: null, folder: root });
  const repository = /** @type {any} */ (workbench.state).repository;
  const graph = repository.graph;
  await graph.load();
  const [third, second, initial] = graph.state.commits.map((c) => c.oid);
  await graph.expand(third);
  await graph.expand(initial);

  write(root, "c.txt", "c amended\n");
  await repository.stage(["c.txt"]);
  assert.deepEqual(await repository.commit({ message: "Third, amended", amend: true }), { ok: true });
  await graph.load();

  const amended = graph.state.commits[0];
  assert.equal(amended.subject, "Third, amended");
  assert.equal(amended.parents[0], second);
  assert.deepEqual([...graph.expanded], [initial]);
  assert.equal(graph.isExpanded(third), false);
});

test("a reload keeps the expanded commits that are still shown", async () => {
  const root = initRepo();
  commit(root, "b.txt", "b\n", "Second");
  const workbench = createWorkbench(nodePlatform);
  await workbench.follow({ machine: null, folder: root });
  const graph = /** @type {any} */ (workbench.state).repository.graph;
  await graph.load();
  const [second] = graph.state.commits.map((c) => c.oid);
  await graph.expand(second);

  commit(root, "c.txt", "c\n", "Third");
  await graph.load();

  assert.equal(graph.state.commits.length, 3);
  assert.deepEqual([...graph.expanded], [second]);
  assert.equal(graph.files(second)?.kind, "ready");
});

test("a Ref change before the Graph's first load doesn't load it", async () => {
  const fake = fakePlatform();
  const root = initRepo();
  const counter = await followCounting(fake, root);

  git(root, "branch", "feature");
  watchOf(fake, root).fire([path.join(root, ".git", "refs", "heads", "feature")]);
  await untilRefreshed(fake, counter);
  await quiet(fake);

  assert.equal(counter.repository.graph.state.kind, "idle");
});

/** Whether this git can make a reftable repository (`--ref-format`, git 2.45+). */
function reftableSupported() {
  try {
    git(tempDir("gitwb-probe-"), "init", "-q", "--ref-format=reftable");
    return true;
  } catch {
    return false;
  }
}

// The watch is hand-fired with the files the commit left in .git/reftable: Node's
// own recursive watch on Windows drops events under load (seen dropping every
// reftable event while other test files ran), so a real watch made this flaky.
test("in a reftable repository, a commit made in a terminal reloads the Graph", { skip: !reftableSupported() && "this git can't `git init --ref-format=reftable` (needs git 2.45+)" }, async () => {
  const root = tempDir("gitwb-reftable-");
  git(root, "init", "-q", "-b", "main", "--ref-format=reftable");
  for (const [k, v] of [["core.autocrlf", "false"], ["user.name", "Test"], ["user.email", "test@example.invalid"], ["commit.gpgsign", "false"]]) git(root, "config", k, v);
  commit(root, "a.txt", "a\n", "Initial");
  const fake = fakePlatform();
  const { repository } = await followCounting(fake, root);
  await repository.graph.load();
  assert.deepEqual(subjects(repository.graph), ["Initial"]);

  commit(root, "b.txt", "b\n", "From the terminal");
  const reftable = path.join(root, ".git", "reftable");
  watchOf(fake, root).fire([path.join(root, "b.txt"), ...fs.readdirSync(reftable).map((f) => path.join(reftable, f))]);
  await until(fake, () => subjects(repository.graph)[0] === "From the terminal");

  assert.deepEqual(subjects(repository.graph), ["From the terminal", "Initial"]);
});

test("a commit that lands after the Repository is disposed doesn't reload its Graph", async () => {
  /** @type {string[][]} */
  const execsAfterDispose = [];
  let disposed = false;
  const platform = { ...nodePlatform, exec: (/** @type {any[]} */ ...a) => {
    if (disposed) execsAfterDispose.push(a[1]);
    return nodePlatform.exec(a[0], a[1], a[2]);
  } };
  const root = initRepo();
  const workbench = createWorkbench(platform);
  await workbench.follow({ machine: null, folder: root });
  const repository = workbench.state.repository;
  await repository.graph.load();

  write(root, "b.txt", "b\n");
  await repository.stage(["b.txt"]);
  const committing = repository.commit({ message: "Late" });
  repository.dispose();
  disposed = true;
  assert.equal((await committing).ok, true);
  await new Promise((r) => setTimeout(r, 200));

  assert.deepEqual(execsAfterDispose.filter((args) => args.includes("log")), [], "no git log after dispose");
});
