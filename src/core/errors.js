// @ts-check
// Errors as values. A failed Git command becomes an ActionError: a one-line
// summary for a band or status line, and the full text on demand.

/**
 * A button on a failure's message that runs a sync, e.g. "Pull (rebase)" →
 * `{ label: "Pull (rebase)", sync: "pull", options: { mode: "rebase" } }`. The
 * panel runs it with `repository.sync(action.sync, action.options)`.
 * @typedef {Readonly<{ label: string, sync: import("./sync.js").SyncName, options?: Readonly<Record<string, unknown>> }>} ErrorAction
 */
/**
 * `actions`, when present, are buttons the message offers (a sync failure's way out).
 * @typedef {{ summary: string, detail: string, actions?: readonly ErrorAction[] }} ActionError
 */

/**
 * An ActionError from Git's output: the first non-blank line is the summary.
 * @param {string} output @param {string} fallback used when Git printed nothing
 * @returns {ActionError}
 */
export function actionError(output, fallback) {
  const detail = output.trim();
  const first = detail.split("\n").find((l) => l.trim()) ?? "";
  return { summary: first.trim() || fallback, detail: detail || fallback };
}

/** The message of anything thrown. @param {unknown} err */
export const messageOf = (err) => String(/** @type {any} */ (err)?.message ?? err);

/**
 * An ActionError from anything thrown (GitNotFound, GitTimeout): its message is both summary and detail.
 * @param {unknown} err @returns {ActionError}
 */
export function errorFrom(err) {
  const message = messageOf(err);
  return { summary: message, detail: message };
}

/**
 * Git's output with stderr first, then stdout, each trimmed, blank ones left out.
 * Hooks and most errors write to stderr; some refusals ("nothing to commit") go to stdout.
 * @param {{ stderr: string, stdout: string }} result
 */
export const outputOf = ({ stderr, stdout }) => [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
