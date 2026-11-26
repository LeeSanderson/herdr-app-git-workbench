// @ts-check
// The RepositoryKey: which Repository, as {machine, toplevel}. This module is its
// one owner: keys are made here, and so is every string form of a key (or of
// anything else that lives on a machine) used by registries and plain-JSON props.

/** @typedef {Readonly<{ machine: string | null, toplevel: string }>} RepositoryKey */

/**
 * A frozen RepositoryKey. A missing or undefined `machine` means this computer (null).
 * @param {{ machine?: string | null, toplevel: string }} key
 * @returns {RepositoryKey}
 */
export function repositoryKey({ machine, toplevel }) {
  return Object.freeze({ machine: machine ?? null, toplevel });
}

/**
 * A stable string for something on `machine`, identified by `parts`.
 * @param {string | null | undefined} machine @param {...string} parts
 */
export function machineId(machine, ...parts) {
  return JSON.stringify([machine ?? null, ...parts]);
}

/**
 * Stable string form of a Repository key, for registries and plain-JSON props.
 * @param {RepositoryKey | string} key
 */
export function repositoryId(key) {
  return typeof key === "string" ? key : machineId(key.machine, key.toplevel);
}
