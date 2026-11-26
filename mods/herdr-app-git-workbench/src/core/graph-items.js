// @ts-check
// The Graph's visible rows, in list order: each commit, and under an expanded
// commit its detail block and then a row per changed file (or one status row
// while its files load or when they failed). Pure; the UI and the Graph key
// logic both walk this list.

/** @typedef {import("./commit-files.js").CommitFile} CommitFile */
/** @typedef {import("./graph.js").CommitFiles} CommitFiles */
/**
 * One visible row. `index` is the commit's index in the snapshot (and in its
 * lane rows), so detail, status and file rows carry its lanes on. `key` is
 * unique and stable: "c:<oid>", "d:<oid>", "s:<oid>" or "f:<oid>:<path>".
 * @typedef {{ key: string, oid: string, index: number } & (
 *   { kind: "commit" } | { kind: "detail" }
 *   | { kind: "status", files: Exclude<CommitFiles, { kind: "ready" }> }
 *   | { kind: "file", file: CommitFile })} GraphItem
 */

/**
 * @param {readonly { oid: string }[]} commits
 * @param {ReadonlySet<string>} expanded oids
 * @param {(oid: string) => CommitFiles | null} filesOf
 * @returns {GraphItem[]}
 */
export function graphItems(commits, expanded, filesOf) {
  /** @type {GraphItem[]} */
  const out = [];
  commits.forEach(({ oid }, index) => {
    out.push({ key: `c:${oid}`, kind: "commit", oid, index });
    if (!expanded.has(oid)) return;
    out.push({ key: `d:${oid}`, kind: "detail", oid, index });
    const files = filesOf(oid) ?? { kind: "loading" };
    if (files.kind !== "ready") out.push({ key: `s:${oid}`, kind: "status", oid, index, files });
    else for (const file of files.files) out.push({ key: `f:${oid}:${file.path}`, kind: "file", oid, index, file });
  });
  return out;
}
