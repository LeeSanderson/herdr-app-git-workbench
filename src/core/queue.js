// @ts-check
// The queue for repository-changing commands: entries run one at a time, in
// the order they were added. One queue per {machine, commonDir}, so Linked
// worktrees of one repository share it. Entries are uncancellable (exec has
// no cancel). Reads (status, diff) skip the queue.

import { machineId } from "./repository-key.js";
import { createSignal } from "./signal.js";

/** @typedef {import("./git.js").TimeoutClass} TimeoutClass */
/** @typedef {Readonly<{ label: string, timeoutClass: TimeoutClass }>} QueueEntry */

/**
 * Stable string form of a queue key.
 * @param {{ machine: string | null, commonDir: string }} key
 */
export function queueId({ machine, commonDir }) {
  return machineId(machine, commonDir.replace(/\\/g, "/").replace(/\/+$/, ""));
}

export function createQueue() {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  /** @type {QueueEntry | null} */
  let running = null;
  let pending = 0;
  const changes = createSignal();
  const emit = changes.emit;

  return {
    /** The entry running now, or null. */
    get running() {
      return running;
    },

    /** True when nothing is running or waiting. */
    get idle() {
      return pending === 0;
    },

    /** Called whenever `running` changes. @param {() => void} fn @returns {() => void} */
    subscribe: changes.subscribe,

    /**
     * Runs `fn` after every entry added before it has finished.
     * @template T
     * @param {{ label: string, timeoutClass: TimeoutClass }} entry
     * @param {(entry: QueueEntry) => Promise<T>} fn
     * @returns {Promise<T>}
     */
    run(entry, fn) {
      const frozen = Object.freeze({ label: entry.label, timeoutClass: entry.timeoutClass });
      pending++;
      const result = tail.then(async () => {
        running = frozen;
        emit();
        try {
          return await fn(frozen);
        } finally {
          running = null;
          pending--;
          emit();
        }
      });
      tail = result.catch(() => {});
      return result;
    },

    /** Resolves once nothing is running or waiting. */
    async drained() {
      while (pending > 0) await tail;
    },
  };
}

/** @typedef {ReturnType<typeof createQueue>} Queue */
