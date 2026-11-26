// @ts-check
// Ref badges and the Ref filter, through the Workbench seam against real repositories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, initRepo, tempDir, git, write } from "./helpers/repo.js";
import { createWorkbench } from "../mods/herdr-app-git-workbench/src/core/workbench.js";
import { nodePlatform, memorySettings } from "./helpers/node-platform.js";

after(cleanup);

/** @param {string} folder @param {import("../mods/herdr-app-git-workbench/src/core/platform.js").Platform} [platform] */
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

/** @param {any} repository */
async function loaded(repository) {
  await repository.graph.load();
  const state = repository.graph.state;
  assert.equal(state.kind, "ready", JSON.stringify(state));
  return state;
}

/** @param {any} state */
const subjects = (state) => state.commits.map((/** @type {any} */ c) => c.subject);

/** A clone of a one-commit origin, with test identity set. Returns both folders. */
function cloned() {
  const origin = initRepo();
  const root = tempDir("gitwb-clone-");
  git(root, "clone", "-q", origin, ".");
  for (const [k, v] of [["core.autocrlf", "false"], ["user.name", "Test"], ["user.email", "test@example.invalid"], ["commit.gpgsign", "false"]]) git(root, "config", k, v);
  return { origin, root };
}

test("an attached HEAD's commit has badges for HEAD (its branch), local and remote branches and tags", async () => {
  const { root } = cloned();
  git(root, "branch", "feature");
  git(root, "tag", "v1");
  write(root, "README.md", "stashed\n");
  git(root, "stash", "-q");
  const { repository } = await follow(root);

  const state = await loaded(repository);
  assert.deepEqual(state.commits[0].badges, [
    { kind: "head", name: "main" },
    { kind: "local", name: "feature" },
    { kind: "remote", name: "origin/main" },
    { kind: "tag", name: "v1" },
  ]);
});

test("a detached HEAD's badge says HEAD, and its branch keeps a local badge", async () => {
  const root = initRepo();
  git(root, "checkout", "-q", "--detach");
  const { repository } = await follow(root);

  const state = await loaded(repository);
  assert.deepEqual(state.commits[0].badges, [
    { kind: "head", name: "HEAD" },
    { kind: "local", name: "main" },
  ]);
});

/**
 * A clone whose Upstream has "Remote work" (fetched, not merged), with "Local work"
 * on HEAD and "Other work" on an unrelated local branch.
 */
function diverged() {
  const { origin, root } = cloned();
  commit(origin, "r.txt", "r\n", "Remote work");
  git(root, "fetch", "-q");
  git(root, "checkout", "-q", "-b", "other");
  commit(root, "o.txt", "o\n", "Other work");
  git(root, "checkout", "-q", "main");
  commit(root, "l.txt", "l\n", "Local work");
  return { origin, root };
}

const sorted = (/** @type {string[]} */ a) => [...a].sort();

test("Auto is the default and shows HEAD plus its Upstream", async () => {
  const { root } = diverged();
  const { repository } = await follow(root);

  assert.equal(repository.graph.filter, "auto");
  assert.deepEqual(sorted(subjects(await loaded(repository))), ["Initial", "Local work", "Remote work"]);
});

test("Current shows HEAD only", async () => {
  const { root } = diverged();
  const { repository } = await follow(root);

  await repository.graph.setFilter("current");
  assert.equal(repository.graph.filter, "current");
  assert.deepEqual(subjects(repository.graph.state), ["Local work", "Initial"]);
});

test("All shows branches, remote branches and tags, but not stash or pull-request refs", async () => {
  const { root } = diverged();
  git(root, "checkout", "-q", "--orphan", "tagged");
  git(root, "rm", "-q", "-rf", ".");
  commit(root, "t.txt", "t\n", "Tagged work");
  git(root, "tag", "t1");
  git(root, "checkout", "-q", "main");
  git(root, "branch", "-q", "-D", "tagged");
  write(root, "README.md", "stashed\n");
  git(root, "stash", "-q");
  git(root, "commit", "-q", "--allow-empty", "-m", "Pull request work");
  git(root, "update-ref", "refs/pull/1/head", "HEAD");
  git(root, "reset", "-q", "--hard", "HEAD~1");
  const { repository } = await follow(root);

  await repository.graph.setFilter("all");
  const state = repository.graph.state;
  assert.deepEqual(sorted(subjects(state)), ["Initial", "Local work", "Other work", "Remote work", "Tagged work"]);
  const kinds = state.commits.flatMap((/** @type {any} */ c) => c.badges.map((/** @type {any} */ b) => `${b.kind}:${b.name}`));
  assert.deepEqual(sorted(kinds), ["head:main", "local:other", "remote:origin/main", "tag:t1"]);
});

test("Auto falls back to HEAD with no Upstream", async () => {
  const { root } = diverged();
  git(root, "branch", "-q", "--unset-upstream");
  const { repository } = await follow(root);

  assert.deepEqual(subjects(await loaded(repository)), ["Local work", "Initial"]);
});

test("Auto falls back to HEAD when the Upstream is gone", async () => {
  const { origin, root } = diverged();
  git(origin, "checkout", "-q", "--detach");
  git(origin, "branch", "-q", "-D", "main");
  git(root, "fetch", "-q", "--prune");
  const { repository } = await follow(root);

  assert.deepEqual(subjects(await loaded(repository)), ["Local work", "Initial"]);
});

test("Auto falls back to HEAD on a detached HEAD", async () => {
  const { root } = diverged();
  git(root, "checkout", "-q", "--detach");
  const { repository } = await follow(root);

  assert.deepEqual(subjects(await loaded(repository)), ["Local work", "Initial"]);
});

test("the Ref filter is remembered per Repository and survives a reload of the mod", async () => {
  const store = new Map();
  const platform = () => /** @type {any} */ ({ ...nodePlatform, ...memorySettings(store) });
  const a = initRepo();
  const b = initRepo();
  const first = { a: await follow(a, platform()), b: await follow(b, platform()) };
  await first.a.repository.graph.setFilter("all");
  await first.b.repository.graph.setFilter("current");

  // A new Workbench over the same store: the mod loaded again.
  const again = { a: await follow(a, platform()), b: await follow(b, platform()) };
  assert.equal(again.a.repository.graph.filter, "all");
  assert.equal(again.b.repository.graph.filter, "current");
  assert.equal((await follow(initRepo(), platform())).repository.graph.filter, "auto");
});
