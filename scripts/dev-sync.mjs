// Copies the mod's runtime files from this repo into Herdr's mods folder.
//
//   node scripts/dev-sync.mjs           one-off mirror
//   node scripts/dev-sync.mjs --watch   mirror, then copy on every save
//
// Why not a junction: Herdr's hot reload does not see saves made behind a
// directory junction in mods/ (check and shot do work through one). See the
// "Dev loop" wayfinder ticket.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MOD_NAME = "herdr-app-git-workbench";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_HOME = process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config", "herdr-app");
const TARGET = path.join(APP_HOME, "mods", MOD_NAME);

const INCLUDE_EXT = new Set([".js", ".mjs", ".json", ".svg", ".png"]);
const EXCLUDE_DIRS = new Set([".git", ".claude", ".agents", "node_modules", "docs", "scripts", "test", "tests", "adapters"]);
const EXCLUDE_FILES = new Set(["jsconfig.json", "package.json", "package-lock.json", "skills-lock.json",
  // Published with the repo for herdr.dev, not part of the mod (Herdr: "leave the recipe and preview out").
  "preview.png"]);

/** Is this repo-relative path (forward slashes) part of the mod? */
export function isModFile(rel) {
  const parts = rel.split("/");
  const name = parts[parts.length - 1];
  if (parts.some((p) => p.startsWith("."))) return false;
  if (parts.slice(0, -1).some((p) => EXCLUDE_DIRS.has(p))) return false;
  if (EXCLUDE_FILES.has(name)) return false;
  if (name.endsWith(".d.ts") || /\.test\.m?js$/.test(name)) return false;
  return INCLUDE_EXT.has(path.extname(name));
}

/** Files Herdr writes into the mod folder itself; never delete them. */
function isHerdrOwned(rel) {
  const name = rel.split("/").pop();
  return name === "jsconfig.json" || name.endsWith(".d.ts") || rel.split("/").some((p) => p.startsWith("."));
}

function walk(root, dir = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && !EXCLUDE_DIRS.has(entry.name)) out.push(...walk(root, rel));
    } else out.push(rel);
  }
  return out;
}

function copy(rel) {
  const src = path.join(REPO, rel);
  const dst = path.join(TARGET, rel);
  const data = fs.readFileSync(src);
  if (fs.existsSync(dst) && fs.readFileSync(dst).equals(data)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  // Write under a hidden name, then rename: Herdr ignores hidden files, so it
  // never reloads a half-written module.
  const tmp = path.join(path.dirname(dst), `.${path.basename(dst)}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, dst);
  return true;
}

function remove(rel) {
  const dst = path.join(TARGET, rel);
  if (!fs.existsSync(dst)) return false;
  fs.rmSync(dst);
  return true;
}

function guardTarget() {
  if (fs.existsSync(TARGET) && fs.lstatSync(TARGET).isSymbolicLink()) {
    console.error(`${TARGET} is a link (junction). Remove it with: cmd /c rmdir "${TARGET}"`);
    process.exit(1);
  }
  fs.mkdirSync(TARGET, { recursive: true });
}

function mirror() {
  const wanted = walk(REPO).filter(isModFile);
  let changed = 0;
  for (const rel of wanted) if (copy(rel)) changed++;
  const keep = new Set(wanted);
  for (const rel of walk(TARGET)) {
    if (!keep.has(rel) && !isHerdrOwned(rel) && remove(rel)) changed++;
  }
  console.log(`synced ${wanted.length} files to ${TARGET} (${changed} changed)`);
}

function watch() {
  const pending = new Map();
  fs.watch(REPO, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const rel = filename.split(path.sep).join("/");
    if (!isModFile(rel)) return;
    clearTimeout(pending.get(rel));
    pending.set(rel, setTimeout(() => {
      pending.delete(rel);
      try {
        const done = fs.existsSync(path.join(REPO, rel)) ? copy(rel) && "copied" : remove(rel) && "removed";
        if (done) console.log(`${new Date().toLocaleTimeString()} ${done} ${rel}`);
      } catch (err) {
        console.error(`failed ${rel}: ${err.message}`);
      }
    }, 75));
  });
  console.log("watching for saves (ctrl-c to stop)");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  guardTarget();
  mirror();
  if (process.argv.includes("--watch")) watch();
}
