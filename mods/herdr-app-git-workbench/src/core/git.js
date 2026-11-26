// @ts-check
// The Git runner: finds git per machine and runs it with an argument array.
// Errors are values: a non-zero exit is a result. Only GitNotFound and
// GitTimeout throw. The runner does not queue.

/** @typedef {import("./platform.js").Platform} Platform */
/** @typedef {{ ok: boolean, code: number, stdout: string, stderr: string }} GitResult */
/**
 * short: quick commands (30 s). graph: a Graph history load, which can be slow on
 * a very large history (60 s). long: commands that may wait on hooks or the
 * network (10 min).
 * @typedef {"short" | "graph" | "long"} TimeoutClass
 */

export class GitNotFound extends Error {
  /** @param {string | null} machine */
  constructor(machine) {
    super(machine == null ? "Git not found" : `Git not found on ${machine}`);
    this.name = "GitNotFound";
    this.machine = machine;
  }
}

export class GitTimeout extends Error {
  /** @param {string[]} args @param {number} timeout */
  constructor(args, timeout) {
    super(`git ${subcommand(args)} timed out after ${Math.round(timeout / 1000)} s`);
    this.name = "GitTimeout";
    this.args = args;
    this.timeout = timeout;
  }
}

/** The git subcommand in `args`, after any leading `-c name=value` pairs. @param {string[]} args */
function subcommand(args) {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i] ?? "";
}

export const TIMEOUTS = { short: 30_000, graph: 60_000, long: 600_000 };
export const STANDARD_FLAGS = ["--no-pager", "-c", "core.quotepath=off"];
export const READ_FLAGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

/**
 * @param {Platform} platform
 */
export function createGit(platform) {
  /** @type {Map<string | null, Promise<string>>} machine → git executable */
  const found = new Map();

  /** @param {string | null} machine */
  function discover(machine) {
    let probe = found.get(machine);
    if (!probe) {
      probe = (async () => {
        for (const exe of ["git", ...platform.gitCandidates(machine)]) {
          try {
            const r = await platform.exec(exe, ["--version"], { on: machine, timeout: TIMEOUTS.short });
            if (r.code === 0 && r.stdout.startsWith("git version")) return exe;
          } catch {
            // can't start: try the next candidate
          }
        }
        throw new GitNotFound(machine);
      })();
      found.set(machine, probe);
      // Don't cache a miss: installing Git should work without a reload.
      probe.catch(() => found.get(machine) === probe && found.delete(machine));
    }
    return probe;
  }

  return {
    /**
     * @param {string | null} machine
     * @param {string[]} args git arguments; file paths always after "--"
     * @param {{ cwd: string, timeoutClass?: TimeoutClass, read?: boolean }} opts
     *   `read: true` adds the read-only flags (no optional locks, no fsmonitor, no index refresh).
     * @returns {Promise<GitResult>}
     */
    async run(machine, args, { cwd, timeoutClass = "short", read = false }) {
      const exe = await discover(machine);
      const timeout = TIMEOUTS[timeoutClass];
      const full = [...STANDARD_FLAGS, ...(read ? READ_FLAGS : []), ...args];
      const started = Date.now();
      try {
        const r = await platform.exec(exe, full, { cwd, on: machine, timeout });
        return { ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr };
      } catch (err) {
        if (err?.timedOut || Date.now() - started >= timeout) throw new GitTimeout(args, timeout);
        // Git was found, so this is a missing cwd or an unreachable machine: a value.
        return { ok: false, code: -1, stdout: "", stderr: String(err?.message ?? err) };
      }
    },
  };
}
