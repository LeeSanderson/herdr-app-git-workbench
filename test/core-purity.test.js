// The core must run inside Herdr's mod runtime and under Node alike, so it may
// not import herdr, gpui-* or Node built-ins, nor use host-only globals.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CORE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "core");

const FORBIDDEN = [
  [/(?:from\s*|import\s*\(\s*|import\s+)["'](?:herdr|gpui-[^"']*)["']/, "imports herdr or gpui-*"],
  [/(?:from\s*|import\s*\(\s*|import\s+)["']node:[^"']*["']/, "imports a Node built-in"],
  [/\b(?:setTimeout|setInterval|process\.env)\b/, "uses a host-only global (use the platform port)"],
];

/** @param {string} dir @returns {string[]} */
function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []);
}

/** @param {string} text */
export function violations(text) {
  return FORBIDDEN.filter(([re]) => re.test(text)).map(([, why]) => why);
}

test("the purity check catches forbidden imports", () => {
  assert.deepEqual(violations(`import { exec } from "herdr";`), ["imports herdr or gpui-*"]);
  assert.deepEqual(violations(`import { View } from 'gpui-kit';`), ["imports herdr or gpui-*"]);
  assert.deepEqual(violations(`const m = await import("gpui-base");`), ["imports herdr or gpui-*"]);
  assert.deepEqual(violations(`import "herdr";`), ["imports herdr or gpui-*"]);
  assert.deepEqual(violations(`import fs from "node:fs";`), ["imports a Node built-in"]);
  assert.deepEqual(violations(`setTimeout(f, 1)`), ["uses a host-only global (use the platform port)"]);
  assert.deepEqual(violations(`import { x } from "./herdr-free.js";`), []);
});

test("the core imports nothing host-specific", () => {
  const files = sources(CORE);
  assert.ok(files.length > 0, "no core sources found");
  for (const file of files) {
    assert.deepEqual(violations(fs.readFileSync(file, "utf8")), [], path.relative(CORE, file));
  }
});
