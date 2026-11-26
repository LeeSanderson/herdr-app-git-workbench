// @ts-check
// Sync: Fetch, Pull and Push with a remote. Never forces. Each sync is one entry on
// the Repository's queue with the long timeout. Exit codes don't tell Git's
// failures apart, so a failure is classified by its text.
//
// Extending: a new sync adds an entry to SYNC_OPS; a new failure class adds a
// rule to FAILURE_RULES and its message to FAILURE_MESSAGES.

import { actionError, outputOf } from "./errors.js";
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
 *   command(ctx: SyncContext, options: Record<string, unknown>): Promise<SyncResult>,
 * }} SyncOp
 *   `verb` names it in messages ("Fetch"), `running` is its queue label ("Fetching…").
 *   `command` runs it and returns Git's result, with the remote it used when known;
 *   a non-zero exit is classified.
 */

/**
 * A failure class: matched from Git's text by FAILURE_RULES, or reported by the
 * command itself ("conflicts", "no-publish-remote"). Each has a FAILURE_MESSAGES entry.
 * @typedef {"auth" | "stalled" | "rejected-push" | "no-upstream" | "divergence" | "would-overwrite" | "conflicts" | "no-publish-remote"} FailureKind
 */

/**
 * A sync command's outcome: Git's result, the remote it used when known, and a
 * failure `kind` (and `branch`, `files`) when the command itself knows it (it then skips the text rules).
 * @typedef {GitResult & { remote?: string, kind?: FailureKind, branch?: string, files?: number }} SyncResult
 */

/** `satisfies`, not `type`, so SyncName is the literal keys. @satisfies {Record<string, SyncOp>} */
export const SYNC_OPS = {
  fetch: {
    verb: "Fetch",
    running: "Fetching…",
    async command(ctx) {
      // Every remote. No --progress (exec can't stream it); pruning follows fetch.prune.
      const r = await ctx.run(["fetch", "--all"]);
      if (r.ok) return r;
      // With one remote, git names only its URL in errors: name the remote instead.
      const names = await remoteNames(ctx);
      return names.length === 1 ? { ...r, remote: names[0] } : r;
    },
  },
  push: {
    verb: "Push",
    running: "Pushing…",
    // Never a force flag of any kind, including --force-with-lease.
    async command(ctx) {
      const branch = await currentBranch(ctx);
      // A configured Upstream counts even when its remote ref is gone.
      // A detached HEAD (no branch) gets a plain push and Git's own error.
      if (!branch || (await config(ctx, `branch.${branch}.merge`))) return ctx.run(["push"]);
      return publish(ctx, branch);
    },
  },
  pull: {
    verb: "Pull",
    running: "Pulling…",
    // Always an explicit mode, and never an autostash. `options.mode` ("merge" or
    // "rebase") is the one-off choice the divergence message offers; it is
    // passed as a flag, never written to config.
    async command(ctx, options) {
      const mode = options.mode === "merge" ? ["--no-rebase", "--ff"]
        : options.mode === "rebase" ? ["--rebase"]
        : await configuredPullMode(ctx);
      const before = await unmergedCount(ctx);
      const r = await ctx.run(["pull", ...mode, "--no-autostash", "--no-edit"]);
      // Conflicts are read from the repository, not the exit code. Files that
      // were unmerged before the pull aren't this pull's conflicts.
      const files = before ? 0 : await unmergedCount(ctx);
      return files ? { ...r, ok: false, kind: /** @type {const} */ ("conflicts"), files } : r;
    },
  },
};

/** How many files the index holds as unmerged (Conflicts). @param {SyncContext} ctx */
async function unmergedCount(ctx) {
  const r = await ctx.run(["ls-files", "--unmerged", "-z"], { read: true });
  if (!r.ok) return 0;
  // Each entry is "<mode> <oid> <stage>\t<path>"; a path has one entry per stage.
  return new Set(r.stdout.split("\0").filter(Boolean).map((e) => e.slice(e.indexOf("\t") + 1))).size;
}

/** The checked-out branch's short name, or "" when HEAD is detached. @param {SyncContext} ctx */
async function currentBranch(ctx) {
  return (await ctx.run(["symbolic-ref", "--short", "-q", "HEAD"], { read: true })).stdout.trim();
}

/** Git's spellings of a false boolean. */
const FALSE = /^(?:false|no|off|0)$/i;

/**
 * The flags matching the user's pull config: `branch.<name>.rebase` (Git lets it
 * override `pull.rebase`) or `pull.rebase`, and `pull.ff`. With none of them set,
 * fast-forward only, so the Workbench never makes a merge or rebase nobody chose.
 * An interactive rebase is pulled as a plain one (there is no editor).
 * @param {SyncContext} ctx @returns {Promise<string[]>}
 */
async function configuredPullMode(ctx) {
  const branch = await currentBranch(ctx);
  const rebase = (branch && (await config(ctx, `branch.${branch}.rebase`))) || (await config(ctx, "pull.rebase"));
  const ff = await config(ctx, "pull.ff");
  if (!rebase && !ff) return ["--ff-only"];
  /** @type {string[]} */
  const flags = [];
  if (rebase) flags.push(FALSE.test(rebase) ? "--no-rebase" : /^m(?:erges)?$/i.test(rebase) ? "--rebase=merges" : "--rebase");
  if (ff) flags.push(/^only$/i.test(ff) ? "--ff-only" : FALSE.test(ff) ? "--no-ff" : "--ff");
  return flags;
}

/** @typedef {keyof typeof SYNC_OPS} SyncName */

/** A config value, or "" when unset. @param {SyncContext} ctx @param {string} name */
async function config(ctx, name) {
  const r = await ctx.run(["config", "--get", name], { read: true });
  return r.ok ? r.stdout.trim() : "";
}

/** The Repository's remote names. @param {SyncContext} ctx @returns {Promise<string[]>} */
async function remoteNames(ctx) {
  const r = await ctx.run(["remote"], { read: true });
  return r.ok ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Publish: pushes HEAD and sets the Upstream. The remote is the first that
 * applies of the branch's push remote, the default push remote, the only remote,
 * then `origin`. When none does (several remotes, no config, no `origin`) it
 * fails as "no-publish-remote"; there is no picker.
 * @param {SyncContext} ctx @param {string} branch
 * @returns {Promise<SyncResult>}
 */
async function publish(ctx, branch) {
  let remote = (branch && (await config(ctx, `branch.${branch}.pushRemote`))) || (await config(ctx, "remote.pushDefault"));
  if (!remote) {
    const names = await remoteNames(ctx);
    remote = names.length === 1 ? names[0] : names.includes("origin") ? "origin" : "";
    if (!remote) {
      const stderr = names.length
        ? `No push remote configured for ${branch}, and no origin among: ${names.join(", ")}`
        : `No remote to publish ${branch} to`;
      return { ok: false, code: 1, stdout: "", stderr, kind: /** @type {const} */ ("no-publish-remote"), branch };
    }
  }
  return { ...(await ctx.run(["push", "--set-upstream", remote, "HEAD"])), remote };
}

/**
 * A recognised failure: its class, plus what its message needs.
 * @typedef {{ kind: FailureKind, remote: string | null, branch?: string, files?: number, seconds?: number }} SyncFailure
 *   `remote` is the remote the failure names (or the command reported), if known;
 *   `branch` the branch the command acted on, when it says; `files` how many
 *   files the failure is about, when known; `seconds` the stall limit a "stalled" sync hit.
 */

/**
 * Failure classes, recognised by Git's error text (stderr and stdout together),
 * checked in order. Git can be localised: unmatched text falls back to Git's own
 * first line. Text from git 2.45.2, see §4 of docs/research/graph-sync-exec.md on the
 * `research/graph-sync-exec` branch (not merged into main).
 * `files`, when present, counts the files the failure names.
 * @type {{ kind: FailureKind, match: RegExp[], files?: (output: string) => number | undefined }[]}
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
  {
    // Git gave up under the sync's stall limit (curl's "Operation too slow").
    kind: "stalled",
    match: [/Operation too slow/],
  },
  {
    // The remote has commits the branch doesn't.
    kind: "rejected-push",
    match: [/\[rejected\].*\((?:non-fast-forward|fetch first)\)/],
  },
  {
    kind: "no-upstream",
    match: [/has no upstream branch/, /There is no tracking information/],
  },
  {
    // A pull that can only fast-forward, or has no mode, found local and remote commits.
    kind: "divergence",
    match: [/Not possible to fast-forward, aborting/, /Need to specify how to reconcile divergent branches/],
  },
  {
    // Git lists each file, tab-indented, under the heading. A rebase pull refuses any
    // local change up front ("cannot pull with rebase"), without a list.
    kind: "would-overwrite",
    match: [/would be overwritten by (?:merge|checkout):/, /cannot pull with rebase: (?:You have unstaged changes|Your index contains uncommitted changes)/],
    files: (output) => {
      const listed = new Set();
      for (const block of output.matchAll(/would be overwritten by (?:merge|checkout):\n((?:\t.*(?:\n|$))+)/g))
        for (const line of block[1].split("\n")) if (line.startsWith("\t")) listed.add(line.slice(1));
      return listed.size || undefined;
    },
  },
];

/**
 * The strip message of each failure class: a summary and, optionally, actions.
 * @type {Record<FailureKind, (failure: SyncFailure, op: SyncOp) => Omit<ActionError, "detail">>}
 */
export const FAILURE_MESSAGES = {
  auth: ({ remote }, op) => ({
    summary: `Couldn't sign in to ${remote ?? "the remote"}. Check your credentials (try \`git ${op.verb.toLowerCase()}\` in a terminal once)`,
  }),
  stalled: ({ remote, seconds }, op) => ({
    summary: `${op.verb} stalled: ${remote ?? "the remote"} sent nothing for ${duration(seconds ?? STALL_SECONDS)}. Check your connection, then try again`,
  }),
  "rejected-push": () => ({
    summary: "Push rejected: the remote has commits you don't have. Pull first",
    actions: [{ label: "Pull", sync: "pull" }],
  }),
  "no-upstream": (_failure, op) => ({
    summary: `${op.verb} needs an Upstream, and this branch has none. Publish it first`,
  }),
  // One-off choices: they pass a mode flag and never write config.
  divergence: () => ({
    summary: "Your branch and its Upstream have diverged",
    actions: [
      { label: "Pull (merge)", sync: "pull", options: { mode: "merge" } },
      { label: "Pull (rebase)", sync: "pull", options: { mode: "rebase" } },
    ],
  }),
  // Never autostashed: the user commits or discards.
  "would-overwrite": ({ files }) => ({
    summary: `Pull would overwrite local changes${files ? ` in ${filesCount(files)}` : ""}. Commit or discard them first`,
  }),
  // Reported by Pull from the repository's state. The Conflicts group and the
  // Operation in progress take over; no Abort/Continue here.
  conflicts: ({ files }) => ({
    summary: `Pull stopped with conflicts in ${filesCount(files ?? 0)}`,
  }),
  // Reported by Publish itself, not matched from Git's text.
  "no-publish-remote": ({ branch }) => ({
    summary: `Can't tell which remote to publish ${branch ?? "this branch"} to. Set one with \`git config remote.pushDefault <remote>\``,
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
  return { kind: rule.kind, remote: failed.length ? failed.join(", ") : remote, files: rule.files?.(output) };
}

/** "1 file", "3 files". @param {number} n */
const filesCount = (n) => `${n} ${n === 1 ? "file" : "files"}`;

/** @typedef {Readonly<{ label: string, enabled: boolean, primary: boolean }>} SyncButton */
/**
 * The snapshot fields the sync buttons read.
 * @typedef {Pick<import("./repository.js").Snapshot, "upstream" | "ahead" | "behind" | "detached" | "operation" | "running">} SyncButtonStatus
 */

/**
 * The Graph toolbar's sync buttons. Counts come from the snapshot's ahead/behind.
 * Pull is primary when behind; Push when ahead and not behind. Anything running
 * disables them; a detached HEAD or an Operation in progress disables Pull and Push.
 * With no Upstream, Pull is disabled and Push reads Publish.
 * @param {SyncButtonStatus} s
 * @returns {{ fetch: SyncButton, pull: SyncButton, push: SyncButton }}
 */
export function syncButtons(s) {
  const idle = s.running === null;
  const onBranch = !s.detached && s.operation === "none";
  const behind = s.behind ?? 0;
  const ahead = s.ahead ?? 0;
  const publish = s.upstream === null && !s.detached;
  return {
    fetch: { label: "Fetch", enabled: idle, primary: false },
    pull: { label: s.behind === null ? "Pull" : `Pull ↓${s.behind}`, enabled: idle && onBranch && s.upstream !== null, primary: behind > 0 },
    push: {
      label: publish ? "Publish" : s.ahead === null ? "Push" : `Push ↑${s.ahead}`,
      enabled: idle && onBranch,
      primary: ahead > 0 && behind === 0,
    },
  };
}

/**
 * Seconds an HTTP transfer may move no data before Git gives up on it. A
 * timeout can't stop Git (Herdr's exec() leaves Git's own processes running on
 * Windows), so a sync asks Git to stop by itself instead. Waiting for sign-in
 * moves no data over HTTP, so this doesn't cut a sign-in short.
 */
export const STALL_SECONDS = 120;

/**
 * Git's `-c` flags for a stall of `seconds`: give up when under 1 byte/s for that long.
 * @param {number} seconds @returns {string[]}
 */
const stallFlags = (seconds) => ["-c", "http.lowSpeedLimit=1", "-c", `http.lowSpeedTime=${seconds}`];

/**
 * Has the user set a stall limit of their own (`http.lowSpeedLimit`/`Time`, also per URL)?
 * @param {SyncContext} ctx @returns {Promise<boolean>}
 */
async function ownStallConfig(ctx) {
  const r = await ctx.run(["config", "--get-regexp", "^http\\..*lowspeed(limit|time)$"], { read: true });
  return r.ok && r.stdout.trim() !== "";
}

/** "45 s", "2 min". @param {number} seconds */
const duration = (seconds) => (seconds >= 120 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`);

/** How long a sync runs before its label adds the sign-in hint. */
export const WAITING_HINT_MS = 15_000;
/** Added to the running label after WAITING_HINT_MS: Git Credential Manager's window may be hidden. */
export const WAITING_HINT = "still waiting — a sign-in window may be open";

/**
 * The message of a sync that hit its timeout. exec() loses Git's partial output
 * on a timeout, so the detail is the timeout itself, then what it means: Herdr
 * stops waiting, but Git may carry on (on Windows it does), so a sign-in finished
 * later still completes the sync.
 * @param {SyncOp} op @param {GitTimeout} err @returns {ActionError}
 */
function timedOut(op, err) {
  const verb = op.verb.toLowerCase();
  const rest = op === SYNC_OPS.pull ? ", including its merge or rebase" : "";
  return {
    summary: `${op.verb} timed out after ${Math.round(err.timeout / 60_000)} min. Git may still be running (a sign-in window may be open)`,
    detail: `${err.message}\n\nThe Workbench stopped waiting, but Git may still be running: Herdr can't always stop it. ` +
      `If a sign-in window is open, finishing sign-in lets the ${verb} complete${rest}; closing the window cancels it.`,
  };
}

/**
 * Runs one sync and turns its outcome into an ActionError (null on success).
 * After WAITING_HINT_MS still running, it relabels its queue entry with the
 * sign-in hint. A timeout gets the timeout message; a classified failure gets its
 * class's message; any other keeps Git's first line. The detail is Git's full
 * output. Throws only GitNotFound.
 * @param {{
 *   git: Git, machine: string | null, cwd: string, timeoutClass: import("./git.js").TimeoutClass,
 *   sleep: (ms: number) => Promise<void>, relabel: (label: string) => void, stallSeconds?: number,
 * }} deps
 *   Each of the sync's Git commands gives up after `stallSeconds` (default STALL_SECONDS)
 *   without data, unless the user has a stall limit of their own.
 * @param {SyncOp} op @param {Record<string, unknown>} options
 * @returns {Promise<ActionError | null>}
 */
export async function runSync({ git, machine, cwd, timeoutClass, sleep, relabel, stallSeconds = STALL_SECONDS }, op, options) {
  /** @type {string[]} */
  let stall = [];
  /** @type {SyncContext} */
  const ctx = {
    run: (args, { read = false } = {}) =>
      git.run(machine, read ? args : [...stall, ...args], { cwd, timeoutClass: read ? "short" : timeoutClass, read }),
  };
  if (!(await ownStallConfig(ctx))) stall = stallFlags(stallSeconds);
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
  const failure = r.kind ? { kind: r.kind, remote: r.remote ?? null, branch: r.branch, files: r.files } : classifyFailure(output, r.remote ?? null);
  if (failure?.kind === "stalled") failure.seconds = stallSeconds;
  return failure ? { ...FAILURE_MESSAGES[failure.kind](failure, op), detail: raw.detail } : raw;
}
