// @ts-check
// Errors as values. A failed Git command becomes an ActionError: a one-line
// summary for a band or status line, and the full text on demand.

/** @typedef {{ summary: string, detail: string }} ActionError */

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
