// PROTOTYPE: throwaway. Builds a scratch Git repository holding one file per
// Diff view special case, for the "Diff view rendering" wayfinder ticket.
//
//   node scripts/prototype-sample-repo.mjs      (re)creates ~/gitwb-diff-sample-PROTOTYPE
//
// Safe to wipe at any time.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.join(os.homedir(), "gitwb-diff-sample-PROTOTYPE");
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const git = (...args) => execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] }).toString();
const write = (rel, data) => { const p = path.join(ROOT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const lines = (arr) => arr.join("\n") + "\n";

git("init", "-q", "-b", "main");
git("config", "core.autocrlf", "false");
git("config", "user.name", "Prototype");
git("config", "user.email", "prototype@example.invalid");

// ---------- baseline ----------
const repoOld = [
  "import { exec } from \"herdr\";",
  "",
  "export class Repository {",
  "  constructor(platform) {",
  "    this.platform = platform;",
  "    this.snapshot = null;",
  "  }",
  "",
  "  subscribe(fn) {",
  "    this.listeners.push(fn);",
  "    return () => {",
  "      this.listeners = this.listeners.filter((f) => f !== fn);",
  "    };",
  "  }",
  "",
  "  async refresh() {",
  "    const status = await this.platform.git([\"status\", \"--porcelain=v2\"]);",
  "    const parsed = parseStatus(status);",
  "    const branch = parsed.branch;",
  "    const files = parsed.files;",
  "    this.snapshot = { branch, files };",
  "    this.emit();",
  "  }",
  "",
  "  emit() {",
  "\tfor (const fn of this.listeners) fn(this.snapshot);",
  "  }",
  "",
  "  stage(path) {",
  "    return this.platform.git([\"add\", \"--\", path]);",
  "  }",
  "",
  "  unstage(path) {",
  "    return this.platform.git([\"restore\", \"--staged\", \"--\", path]);",
  "  }",
  "}",
];
write("src/repository.js", lines(repoOld));

const queueOld = ["export function createQueue() {", "  const jobs = [];", "  let running = false;", "  return {", "    push(job) { jobs.push(job); },", "  };", "}"];
write("src/queue.js", lines(queueOld));

const oldName = ["// Diff rows", "export function rows(lines) {", "  return lines.map((l) => ({ text: l }));", "}"];
write("src/old-name.js", lines(oldName));

write("docs/notes.md", lines(["# Notes", "", "These notes are obsolete.", "", "- one", "- two", "- three"]));

const png = (seed) => { const b = Buffer.alloc(2048); for (let i = 0; i < b.length; i++) b[i] = (i * 31 + seed * 7) & 0xff; b.write("\x89PNG\r\n\x1a\n", 0, "latin1"); return b; };
write("assets/logo.png", png(1));

const large = Array.from({ length: 20000 }, (_, i) => `line ${String(i + 1).padStart(5, "0")}: the quick brown fox jumps over the lazy dog`);
write("data/large.txt", lines(large));

const longOld = [
  "// A file with very long lines, to judge wrap versus truncate versus horizontal scroll.",
  "export const QUERY = \"SELECT id, name, email, created_at, updated_at, last_login_at, status, role, team_id, manager_id, locale, timezone FROM users WHERE status = 'active' AND role IN ('admin', 'editor') ORDER BY created_at DESC LIMIT 100\";",
  "export const short = 1;",
  "export function render(x) { return `<div class=\"card card--primary card--elevated\" data-id=\"${x.id}\" data-name=\"${x.name}\" aria-label=\"${x.label}\">${x.body}</div>`; }",
];
write("src/long-lines.js", lines(longOld));

write("config/no-eol.txt", lines(["alpha", "beta", "gamma"]));
write("config/crlf.txt", ["first", "second", "third", ""].join("\r\n"));
write("src/tabs.go", lines(["package main", "", "func main() {", "\tif true {", "\t\tprintln(\"tabs\")", "\t}", "}"]));

git("add", "-A");
git("commit", "-q", "-m", "Baseline");

// ---------- changes ----------
// Unstaged modification with every pairing shape: 1→1, 3→1, 0→4, 2→0, whitespace-only, tab line.
const repoNew = [...repoOld];
repoNew[5] = "    this.snapshot = EMPTY;";                                   // 1 -> 1
repoNew.splice(9, 0, "    this.listeners ??= [];");                          // pure add above
repoNew.splice(17, 4, "    const { branch, files } = parseStatus(status);"); // 4 -> 1 (status/parsed/branch/files)
repoNew.splice(20, 0, "    this.version++;", "    this.lastRefresh = Date.now();", "    log(`refreshed ${files.length} files`);", ""); // 0 -> 4
const emitAt = repoNew.findIndex((l) => l.startsWith("\tfor"));
repoNew[emitAt] = "    for (const fn of this.listeners) fn(this.snapshot);";    // tab -> spaces (whitespace only)
const unstageAt = repoNew.findIndex((l) => l.startsWith("  unstage("));
repoNew.splice(unstageAt, 4);                                              // remove 4 lines (method)
write("src/repository.js", lines(repoNew));

// Staged change plus a further unstaged change on the same file.
const queueStaged = [...queueOld];
queueStaged[4] = "    push(job) { jobs.push(job); drain(); },";
write("src/queue.js", lines(queueStaged));
git("add", "src/queue.js");
const queueWork = [...queueStaged];
queueWork.splice(5, 0, "    get size() { return jobs.length; },");
write("src/queue.js", lines(queueWork));

// Rename with an edit, staged.
git("mv", "src/old-name.js", "src/new-name.js");
write("src/new-name.js", lines(["// Diff rows (renamed)", ...oldName.slice(1)]));
git("add", "src/new-name.js");

// New file, staged.
write("src/brand-new.js", lines(["export function loadDiff(target) {", "  // brand new file", "  return { rows: [] };", "}"]));
git("add", "src/brand-new.js");

// Deleted, unstaged.
fs.rmSync(path.join(ROOT, "docs/notes.md"));

// Untracked.
write("scratch/untracked.txt", lines(["an untracked file", "with two lines"]));

// Binary modified.
write("assets/logo.png", png(2));

// Large file: three small edits far apart.
const largeNew = [...large];
largeNew[120] = "line 00121: the quick brown CAT jumps over the lazy dog";
largeNew.splice(9000, 2);
largeNew.splice(18500, 0, "an inserted line near the end");
write("data/large.txt", lines(largeNew));

// Long lines edited mid-line.
const longNew = [...longOld];
longNew[1] = longOld[1].replace("LIMIT 100", "LIMIT 250").replace("timezone", "timezone, avatar_url");
longNew[3] = longOld[3].replace("card--elevated", "card--flat");
write("src/long-lines.js", lines(longNew));

// Trailing newline removed.
write("config/no-eol.txt", ["alpha", "beta", "gamma"].join("\n"));
// CRLF file edited.
write("config/crlf.txt", ["first", "SECOND", "third", ""].join("\r\n"));
// Tabs edited.
write("src/tabs.go", lines(["package main", "", "func main() {", "\tif true {", "\t\tprintln(\"tabs, edited\")", "\t}", "}"]));

console.log(`sample repository ready: ${ROOT}`);
console.log(git("status", "--short"));
