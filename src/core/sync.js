// @ts-check
// Sync: Fetch (and later Pull and Push) with a remote. Each sync is one entry on
// the Repository's queue with the long timeout. Exit codes don't tell Git's
// failures apart, so a failure is classified by its text.
//
// Extending: a new sync adds an entry to SYNC_OPS; a new failure class adds a
// rule to FAILURE_RULES and its message to FAILURE_MESSAGES.

import { actionError } from "./errors.js";
import { GitTimeout } from "./git.js";

/** @typedef {ReturnType<import("./git.js").createGit>} Git */
/** @typedef {import("./git.js").GitResult} GitResult */
/** @typedef {import("./errors.js").ActionError} ActionError */

/**
 * What a sync command can use.
 * @typedef {{
 *   run(args: string[], opts?: { read?: boolean }): Promise<GitResult>,
 * }} SyncContext
 *   `run` runs git in the Repository with the sync's timeout (`read` runs a quick read).
 */

/**
 * One sync operation.
 * @typedef {{
 *   verb: string,
 *   running: string,
 *   command(ctx: SyncContext, options: Record<string, unknown>): Promise<GitResult & { remote?: string }>,
 * }} SyncOp
 *   `verb` names it in messages ("Fetch"), `running` is its queue label ("Fetching…").
 *   `command` runs it and returns Git's result, with the remote it used when known;
 *   a non-zero exit is classified.
 */

/** @type {Record<string, SyncOp>} */
export const SYNC_OPS = {
  fetch: {
    verb: "Fetch",
    running: "Fetching…",
    async command(ctx) {
      // Every remote. No --progress (exec can't stream it); pruning follows fetch.prune.
      const r = await ctx.run(["fetch", "--all"]);
      if (r.ok) return r;
      // With one remote, git names only its URL in errors: name the remote instead.
      const remotes = await ctx.run(["remote"], { read: true });
      const names = remotes.ok ? remotes.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
      return names.length === 1 ? { ...r, remote: names[0] } : r;
    },
  },
};

/** @typedef {keyof typeof SYNC_OPS} SyncName */

/**
 * A recognised failure: its class, plus what its message needs.
 * @typedef {{ kind: string, remote: string | null }} SyncFailure
 *   `remote` is the remote the failure names (or the command reported), if known.
 */

/**
 * Failure classes, recognised by Git's error text (stderr and stdout together),
 * checked in order. Git can be localised: unmatched text falls back to Git's own
 * first line. Text from git 2.45.2, see docs/research/graph-sync-exec.md §4.
 * @type {{ kind: string, match: RegExp[] }[]}
 */
export const FAILURE_RULES = [
  {
    kind: "auth",
    match: [
      /Authentication failed for /,
      /could not read (?:Username|Password) for /,
      /Cannot prompt because user interactivity has been disabled/,
      /Permission denied \(publickey/,
      /Host key verification failed/,
    ],
  },
];

/**
 * The strip message of each failure class: a summary and, optionally, actions.
 * @type {Record<string, (failure: SyncFailure, op: SyncOp) => Omit<ActionError, "detail">>}
 */
export const FAILURE_MESSAGES = {
  auth: ({ remote }, op) => ({
    summary: `Couldn't sign in to ${remote ?? "the remote"}. Check your credentials (try \`git ${op.verb.toLowerCase()}\` in a terminal once)`,
  }),
};

/**
 * Classifies Git's output from a failed sync. Null when no class matches.
 * @param {string} output stderr and stdout @param {string | null} [remote] the remote the command used, if one
 * @returns {SyncFailure | null}
 */
export function classifyFailure(output, remote = null) {
  const rule = FAILURE_RULES.find((r) => r.match.some((re) => re.test(output)));
  if (!rule) return null;
  // `fetch --all` with several remotes names each one that failed.
  const failed = [...output.matchAll(/could not fetch (\S+)/g)].map((m) => m[1]);
  return { kind: rule.kind, remote: failed.length ? failed.join(", ") : remote };
}

/** @typedef {Readonly<{ label: string, enabled: boolean, primary: boolean }>} SyncButton */
/**
 * The snapshot fields the sync buttons read.
 * @typedef {Pick<import("./repository.js").Snapshot, "upstream" | "ahead" | "behind" | "detached" | "operation" | "running">} SyncButtonStatus
 */

/**
 * The Graph toolbar's sync buttons. Counts come from the snapshot's ahead/behind.
 * Pull is primary when behind; Push when ahead and not behind. Anything running
 * disables them. Pull and Push stay disabled until they are built (#49, #50).
 * @param {SyncButtonStatus} s
 * @returns {{ fetch: SyncButton, pull: SyncButton, push: SyncButton }}
 */
export function syncButtons(s) {
  const idle = s.running === null;
  const behind = s.behind ?? 0;
  const ahead = s.ahead ?? 0;
  return {
    fetch: { label: "Fetch", enabled: idle, primary: false },
    pull: { label: s.behind === null ? "Pull" : `Pull ↓${s.behind}`, enabled: false, primary: behind > 0 },
    push: { label: s.ahead === null ? "Push" : `Push ↑${s.ahead}`, enabled: false, primary: ahead > 0 && behind === 0 },
  };
}

/** How long a sync runs before its label adds the sign-in hint. */
export const WAITING_HINT_MS = 15_000;
/** Added to the running label after WAITING_HINT_MS: Git Credential Manager's window may be hidden. */
export const WAITING_HINT = "still waiting — a sign-in window may be open";

/**
 * The message of a sync that hit its timeout. exec() loses Git's partial output
 * on a timeout, so the detail is the timeout itself.
 * @param {SyncOp} op @param {GitTimeout} err @returns {ActionError}
 */
function timedOut(op, err) {
  return { summary: `${op.verb} timed out after ${Math.round(err.timeout / 60_000)} min (sign-in not completed?)`, detail: err.message };
}

/**
 * Runs one sync and turns its outcome into an ActionError (null on success).
 * After WAITING_HINT_MS still running, it relabels its queue entry with the
 * sign-in hint. A timeout gets the timeout message; a classified failure gets its
 * class's message; any other keeps Git's first line. The detail is Git's full
 * output. Throws only GitNotFound.
 * @param {{
 *   git: Git, machine: string | null, cwd: string, timeoutClass: import("./git.js").TimeoutClass,
 *   sleep: (ms: number) => Promise<void>, relabel: (label: string) => void,
 * }} deps
 * @param {SyncOp} op @param {Record<string, unknown>} options
 * @returns {Promise<ActionError | null>}
 */
export async function runSync({ git, machine, cwd, timeoutClass, sleep, relabel }, op, options) {
  /** @type {SyncContext} */
  const ctx = {
    run: (args, { read = false } = {}) => git.run(machine, args, { cwd, timeoutClass: read ? "short" : timeoutClass, read }),
  };
  let finished = false;
  void sleep(WAITING_HINT_MS).then(() => {
    if (!finished) relabel(`${op.running} ${WAITING_HINT}`);
  });
  let r;
  try {
    r = await op.command(ctx, options);
  } catch (err) {
    if (err instanceof GitTimeout) return timedOut(op, err);
    throw err;
  } finally {
    finished = true;
  }
  if (r.ok) return null;
  const output = [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join("\n");
  const raw = actionError(output, `git ${op.verb.toLowerCase()} failed`);
  const failure = classifyFailure(output, r.remote ?? null);
  return failure ? { ...FAILURE_MESSAGES[failure.kind](failure, op), detail: raw.detail } : raw;
}
