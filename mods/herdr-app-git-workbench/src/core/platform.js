// @ts-check
// The platform port: everything the herdr-free core needs from its host.
// Adapters: src/ui/herdr-platform.js (the mod) and test/helpers/node-platform.js (tests).
// Types only; nothing here runs.

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} ExecResult
 */

/**
 * A recursive folder watch. `events` yields batches of absolute changed paths
 * until `cancel()` is called, and throws if the watch fails. On Windows, Herdr's
 * paths are in verbatim form (`\\?\C:\...`); watch-filter.js accepts both forms.
 * @typedef {{ events: AsyncIterable<string[]>, cancel(): void }} Watch
 */

/**
 * @typedef {object} Platform
 * @property {(cmd: string, args: string[], opts: { cwd?: string, on?: string | null, timeout?: number }) => Promise<ExecResult>} exec
 *   Runs a program with an argument array (never a shell string). Resolves on any
 *   exit code. Rejects when the program can't start (not installed, no such cwd,
 *   machine unreachable) and on timeout; a rejection may carry `timedOut: true`.
 * @property {(path: string) => Watch} watch
 *   Watches a local folder recursively.
 * @property {(path: string, opts: { on?: string | null }) => Promise<string | null>} readTextFile
 *   UTF-8 text, or null when the file is absent.
 * @property {(ms: number) => Promise<void>} sleep
 *   Resolves after `ms`. The mod runtime has no global timers; this is the core's only timer.
 * @property {(machine: string | null) => string[]} gitCandidates
 *   Absolute paths to try, in order, when `git` is not on PATH on `machine`
 *   (Windows: %ProgramFiles%\Git\cmd\git.exe, then %LOCALAPPDATA%\Programs\Git\cmd\git.exe).
 * @property {(key: string) => unknown} getSetting
 *   A persisted setting, or null when it was never set. Survives a reload of the mod.
 * @property {(key: string, value: string | number | boolean | null) => void} setSetting
 *   Persists a setting (plain JSON values only).
 */

export {};
