import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tempDir, cleanup, initRepo, unbornRepo, git, samePath } from "./helpers/repo.js";
import { createWorkbench } from "../mods/herdr-app-git-workbench/src/core/workbench.js";
import { nodePlatform } from "./helpers/node-platform.js";

after(cleanup);

test("following a folder outside any repository gives no-repository", async () => {
  const folder = tempDir();
  const workbench = createWorkbench(nodePlatform);
  await workbench.follow({ machine: null, folder });
  assert.equal(workbench.state.kind, "no-repository");
  assert.equal(workbench.state.folder, folder);
});

test("following a repository shows its branch and HEAD commit", async () => {
  const folder = initRepo({ branch: "feature/x" });
  const workbench = createWorkbench(nodePlatform);
  await workbench.follow({ machine: null, folder });
  assert.equal(workbench.state.kind, "ready");
  const { snapshot } = workbench.state.repository;
  assert.equal(snapshot.branch, "feature/x");
  assert.equal(snapshot.headOid, git(folder, "rev-parse", "HEAD").trim());
  assert.equal(snapshot.unborn, false);
});

test("a repository with no commits shows its unborn branch", async () => {
  const folder = unbornRepo({ branch: "trunk" });
  const workbench = createWorkbench(nodePlatform);
  await workbench.follow({ machine: null, folder });
  const { snapshot } = workbench.state.repository;
  assert.equal(snapshot.branch, "trunk");
  assert.equal(snapshot.unborn, true);
  assert.equal(snapshot.headOid, null);
});

test("a subfolder of a repository resolves to its top level", async () => {
  const root = initRepo({ files: { "src/deep/a.txt": "a\n" } });
  const workbench = createWorkbench(nodePlatform);
  await workbench.follow({ machine: null, folder: path.join(root, "src", "deep") });
  const { repository } = workbench.state;
  assert.ok(samePath(repository.key.toplevel, root), `${repository.key.toplevel} vs ${root}`);
  assert.equal(repository.key.machine, null);
  assert.equal(workbench.repository(repository.key), repository);
});

test("following another repository switches to it and drops the first", async () => {
  const a = initRepo({ branch: "a" });
  const b = initRepo({ branch: "b" });
  const workbench = createWorkbench(nodePlatform);
  await workbench.follow({ machine: null, folder: a });
  const first = workbench.state.repository;
  await workbench.follow({ machine: null, folder: b });
  assert.equal(workbench.state.repository.snapshot.branch, "b");
  assert.equal(workbench.repository(first.key), undefined);
});

test("when follows overlap, the latest one wins", async () => {
  const a = initRepo({ branch: "a" });
  const b = initRepo({ branch: "b" });
  const workbench = createWorkbench(nodePlatform);
  await Promise.all([workbench.follow({ machine: null, folder: a }), workbench.follow({ machine: null, folder: b })]);
  assert.equal(workbench.state.repository.snapshot.branch, "b");
});

// Every panel copy shares the one Workbench, so a copy that was hidden while another
// followed elsewhere must ask the Workbench, not remember what it followed itself.
test("isFollowing names the place the latest follow asked for", async () => {
  const a = initRepo({ branch: "a" });
  const b = initRepo({ branch: "b" });
  const workbench = createWorkbench(nodePlatform);
  assert.equal(workbench.isFollowing({ machine: null, folder: a }), false);
  await workbench.follow({ machine: null, folder: a });
  assert.equal(workbench.isFollowing({ machine: null, folder: a }), true);
  const pending = workbench.follow({ machine: null, folder: b });
  assert.equal(workbench.isFollowing({ machine: null, folder: a }), false, "another copy moved the Workbench on");
  assert.equal(workbench.isFollowing({ machine: null, folder: b }), true);
  await pending;
  assert.equal(workbench.isFollowing({ machine: "box", folder: b }), false, "the machine counts");
});

test("subscribers hear each state change", async () => {
  const folder = initRepo();
  const workbench = createWorkbench(nodePlatform);
  const seen = [];
  const unsubscribe = workbench.subscribe(() => seen.push(workbench.state.kind));
  await workbench.follow({ machine: null, folder });
  unsubscribe();
  await workbench.follow({ machine: null, folder: tempDir() });
  assert.deepEqual(seen, ["loading", "ready"]);
});

/** A platform on which no program can start, like a machine without Git. */
const noGitPlatform = {
  ...nodePlatform,
  exec: (cmd) => Promise.reject(Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" })),
};

test("following a folder when Git can't be found gives git-missing", async () => {
  const folder = initRepo();
  const workbench = createWorkbench(noGitPlatform);
  await workbench.follow({ machine: null, folder });
  assert.equal(workbench.state.kind, "git-missing");
});

test("Git is found at an install location when it isn't on PATH", async () => {
  const realGit = execFileSync(process.platform === "win32" ? "where" : "which", ["git"]).toString().split(/\r?\n/)[0].trim();
  const offPath = {
    ...nodePlatform,
    exec: (cmd, args, opts) => (cmd === "git" ? noGitPlatform.exec(cmd) : nodePlatform.exec(cmd, args, opts)),
    gitCandidates: () => [path.join(tempDir(), "missing", "git.exe"), realGit],
  };
  const folder = initRepo();
  const workbench = createWorkbench(offPath);
  await workbench.follow({ machine: null, folder });
  assert.equal(workbench.state.kind, "ready");
});
