// Shared test setup: temporary repositories built with real git.
// Ported from scripts/prototype-sample-repo.mjs on the prototype/diff-view branch.
//
// Importing this module isolates every git call in the test process (and the
// code under test, which inherits process.env through nodePlatform) from the
// user's system and global git config.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { closeAllWatches } from "../../src/adapters/node-platform.js";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitwb-config-"));
const emptyConfig = path.join(configDir, "gitconfig");
fs.writeFileSync(emptyConfig, "");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.on("exit", () => fs.rmSync(configDir, { recursive: true, force: true }));

/** A fresh empty temp folder. Removed by `cleanup()`. */
export function tempDir(prefix = "gitwb-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}
const created = [];

/** Removes every temp folder made so far. Call it from `after`. */
export async function cleanup() {
  // Windows can't delete a folder that is being watched, and a watch's handle
  // is only released after the event loop turns.
  closeAllWatches();
  await new Promise((r) => setTimeout(r, 50));
  for (const dir of created.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Runs git synchronously in `cwd`; returns stdout. Throws on a non-zero exit. */
export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

/** Writes a file (creating folders) under `root`. */
export function write(root, rel, data) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

/** Joins lines with LF and a final newline. */
export const lines = (arr) => arr.join("\n") + "\n";

/** Deterministic binary data that starts with the PNG signature. */
export function png(seed) {
  const b = Buffer.alloc(2048);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + seed * 7) & 0xff;
  b.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  return b;
}

/** An empty repository on branch `branch` with no commits (unborn). */
export function unbornRepo({ branch = "main" } = {}) {
  const root = tempDir("gitwb-repo-");
  git(root, "init", "-q", "-b", branch);
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  return root;
}

/** A repository with one commit holding `files` ({rel: content}). */
export function initRepo({ branch = "main", files = { "README.md": "hello\n" } } = {}) {
  const root = unbornRepo({ branch });
  for (const [rel, data] of Object.entries(files)) write(root, rel, data);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "Initial");
  return root;
}

/** Compares paths across git's `C:/x` and Node's `C:\x` spellings. */
export const samePath = (a, b) => norm(a) === norm(b);
const norm = (p) => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
};
