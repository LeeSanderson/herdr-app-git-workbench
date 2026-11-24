// @ts-check
// The platform port on Herdr (see src/core/platform.js).
//
// Timers: the mod runtime has no setTimeout and only a `cx` can sleep, but the
// core must never hold a cx. So this adapter runs one long-lived host task
// (`owner: null`, outliving every view) that turns `sleep(ms)` requests into
// `cx.timer.after` calls. The first copy's `init` starts it with `startHost(cx)`.
// Sleeps requested before the host starts wait for it.

import { exec, readTextFile, watchFolder, home, checking } from "herdr";
import os from "os";

/** @type {{ ms: number, resolve: () => void }[]} */
const sleepers = [];
/** @type {(() => void) | null} */
let wakeHost = null;
let hostStarted = false;

/**
 * Starts the timer host task once per build. Call from every copy's `init`.
 * @param {import("gpui-kit").Context} cx
 */
export function startHost(cx) {
  // Under `herdr-app check` nothing follows, so nothing sleeps; a host task
  // there is only reported as stranded work.
  if (hostStarted || checking()) return;
  hostStarted = true;
  cx.spawn(async (cx) => {
    for (;;) {
      while (sleepers.length) {
        const { ms, resolve } = /** @type {{ ms: number, resolve: () => void }} */ (sleepers.shift());
        cx.timer.after(ms, () => resolve(), { owner: null });
      }
      await new Promise((r) => (wakeHost = () => r(undefined)));
      wakeHost = null;
    }
  }, { owner: null });
}

const isWindows = () => /^win/i.test(os.platform());

/** @type {import("../core/platform.js").Platform} */
export const herdrPlatform = {
  exec: (cmd, args, opts) => exec(cmd, args, opts),

  // watchFolder is local only (no `on`): the core must not watch a remote
  // Repository through this, or must accept that it never fires.
  // Unverified: watchFolder calls are cancelled when the copy that made them
  // closes; whether that applies to a call made from module-scope core code is
  // for #22 to check.
  watch(path) {
    let done = false;
    /** @type {import("herdr").FolderWatch | null} */
    let pending = null;
    return {
      events: (async function* () {
        while (!done) {
          pending = watchFolder(path);
          const paths = await pending;
          if (paths.length && !done) yield paths;
        }
      })(),
      cancel() {
        done = true;
        pending?.cancel();
      },
    };
  },

  readTextFile: (path, opts) => readTextFile(path, opts),

  sleep(ms) {
    return new Promise((resolve) => {
      sleepers.push({ ms, resolve });
      wakeHost?.();
    });
  },

  // No process.env in the mod runtime: build the standard Git for Windows
  // locations from fixed paths and home(). Remote machines: PATH only.
  gitCandidates(machine) {
    if (machine != null || !isWindows()) return [];
    return [
      "C:\\Program Files\\Git\\cmd\\git.exe",
      `${home()}\\AppData\\Local\\Programs\\Git\\cmd\\git.exe`,
    ];
  },
};
