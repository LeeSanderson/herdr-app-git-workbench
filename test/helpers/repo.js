// Shared test setup: temporary repositories built with real git.
// Ported from scripts/prototype-sample-repo.mjs on the prototype/diff-view branch.
//
// Importing this module isolates every git call in the test process (and the
// code under test, which inherits process.env through nodePlatform) from the
// user's system and global git config.

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { closeAllWatches } from "./node-platform.js";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitwb-config-"));
const emptyConfig = path.join(configDir, "gitconfig");
fs.writeFileSync(emptyConfig, "");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
// Never prompt or reach a credential helper: a sync test that needs credentials
// fails fast instead of waiting on a terminal or a sign-in window.
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GCM_INTERACTIVE = "never";
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "credential.helper";
process.env.GIT_CONFIG_VALUE_0 = ""; // an empty value clears the helper list
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
  identify(root);
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

/** Sets the test identity (and LF endings, no signing) on a working copy. */
function identify(root) {
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
}

/** An empty bare repository, to use as a local remote. */
export function bareRepo({ branch = "main" } = {}) {
  const dir = tempDir("gitwb-bare-");
  git(dir, "init", "-q", "--bare", "-b", branch);
  return dir;
}

/** A clone of `remote` (a path) with the test identity set. */
export function cloneRepo(remote) {
  const root = tempDir("gitwb-clone-");
  git(root, "clone", "-q", remote, ".");
  identify(root);
  return root;
}

/**
 * A local bare `remote` holding one commit on `branch`, the working copy `root`
 * that tracks it as `origin`, and a second clone `other` for "someone else's"
 * commits. No network is involved.
 */
export function remoteRepo({ branch = "main", files } = {}) {
  const remote = bareRepo({ branch });
  const root = initRepo({ branch, files });
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", branch);
  const other = cloneRepo(remote);
  return { remote, root, other };
}

/** Commits `file` with `content` in `root`. */
export function commitFile(root, file, content, message = `edit ${file}`) {
  write(root, file, content);
  git(root, "add", "--", file);
  git(root, "commit", "-q", "-m", message);
}

/**
 * A local HTTP remote that refuses every request with 401, so git needs
 * credentials it can't get (prompts and helpers are off). Call `close()` when done.
 * @returns {Promise<{ url: string, close(): Promise<void> }>}
 */
export async function unauthorisedRemote() {
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/**
 * A remote that accepts connections and never answers, as a dead server or a
 * stalled network looks to Git.
 */
export async function silentRemote() {
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

/** Compares paths across git's `C:/x` and Node's `C:\x` spellings. */
export const samePath = (a, b) => norm(a) === norm(b);
const norm = (p) => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
};

/** The document of a loadDiff result; fails the test with Git's error otherwise. */
export function docOf(result) {
  if (!result.ok) throw new Error(`loadDiff failed: ${result.error.detail}`);
  return result.doc;
}