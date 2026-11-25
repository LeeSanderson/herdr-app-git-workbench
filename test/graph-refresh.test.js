// @ts-check
// The Graph stays current: Ref changes reload it, file edits don't, and a reload
// keeps the loaded count and the expanded commits.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { cleanup, initRepo, git, write } from "./helpers/repo.js";
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
