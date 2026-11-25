// @ts-nocheck (Node-only; jsconfig has no Node types)
// The platform port on Node, for tests. Never imported by the mod, and excluded
// from dev-sync.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Cancels of every watch still open. */
const openWatches = new Set();

/**
 * Stops every watch still open. On Windows a watched folder can't be deleted
 * (EBUSY), so test cleanup calls this before removing temp repositories.
 */
export function closeAllWatches() {
  for (const cancel of [...openWatches]) cancel();
}

/**
 * The settings half of the platform port, kept in memory. Two platforms that
 * share one store stand in for two loads of the mod.
 */
export function memorySettings(store = new Map()) {
  return {
    getSetting: (key) => (store.has(key) ? store.get(key) : null),
    setSetting: (key, value) => void store.set(key, value),
  };
}

/** @type {import("../core/platform.js").Platform} */
export const nodePlatform = {
  ...memorySettings(),

  exec(cmd, args, { cwd, timeout = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        if (err.killed || err.signal) return reject(Object.assign(new Error(`timed out: ${cmd}`), { timedOut: true }));
        if (typeof err.code === "number") return resolve({ code: err.code, stdout, stderr });
        reject(err); // ENOENT and friends: the program could not start
      });
    });
  },

  watch(dir) {
    const queue = [];
    let wake = null;
    let done = false;
    // Not persistent: a watch left running must not keep a test process alive.
    const cancel = () => {
      if (done) return;
      done = true;
      openWatches.delete(cancel);
      watcher.close();
      wake?.();
    };
    openWatches.add(cancel);
    const watcher = fs.watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
      // On Windows, deleting the watched folder (test cleanup) makes the watcher
      // fire endlessly with bogus `?\C:\...` names: end the watch instead.
      if (!fs.existsSync(dir)) return cancel();
      if (!filename) return;
      queue.push(path.join(dir, filename.toString()));
      wake?.();
    });
    watcher.on("error", cancel);
    return {
      events: (async function* () {
        while (!done) {
          if (!queue.length) await new Promise((r) => (wake = r));
          wake = null;
          if (queue.length && !done) yield queue.splice(0);
        }
      })(),
      cancel,
    };
  },

  async readTextFile(file) {
    try {
      return await fs.promises.readFile(file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  },

  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

  gitCandidates(machine) {
    if (machine != null || process.platform !== "win32") return [];
    const out = [];
    if (process.env.ProgramFiles) out.push(path.join(process.env.ProgramFiles, "Git", "cmd", "git.exe"));
    if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe"));
    return out;
  },
};
