// @ts-check
// Two small patterns the core repeats: listeners to tell about a change, and a
// task whose calls during a run merge into one follow-up run.

/**
 * A set of listeners. `subscribe` returns the unsubscribe function; `emit` calls
 * every listener subscribed at that moment.
 */
export function createSignal() {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  return {
    /** @param {() => void} fn @returns {() => void} */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit() {
      for (const fn of [...listeners]) fn();
    },
    clear() {
      listeners.clear();
    },
  };
}

/**
 * Wraps `task` so at most one run is in flight: a call while it runs merges into
 * a single follow-up run, which every such caller shares. The in-flight run is
 * cleared before `after` and the callers see its result, so a call they make
 * starts a new run.
 * @template T
 * @param {() => Promise<T>} task
 * @param {(result: T) => void} [after] called once per successful run
 * @returns {() => Promise<T>}
 */
export function coalesce(task, after) {
  /** @type {Promise<T> | null} */
  let running = null;
  /** @type {Promise<T> | null} */
  let followUp = null;
  function run() {
    // Always asynchronous, so `running` is set before the task can finish.
    const current = Promise.resolve().then(task).then(
      (result) => {
        if (running === current) running = null;
        after?.(result);
        return result;
      },
      (err) => {
        if (running === current) running = null;
        throw err;
      },
    );
    return current;
  }
  function call() {
    if (!running) return (running = run());
    if (!followUp) {
      const next = () => {
        followUp = null;
        return call();
      };
      followUp = running.then(next, next);
    }
    return followUp;
  }
  return call;
}
