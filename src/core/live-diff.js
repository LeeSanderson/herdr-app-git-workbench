// @ts-check
// A live Diff: the DiffDocument of one Diff target, kept current while its
// Repository is followed. The Diff view owns one per tab.
//
// It looks up `workbench.repository(target.repository)` on every Workbench state
// change and reloads on every snapshot change of that Repository. At most one
// load runs at a time; reloads asked for meanwhile merge into one follow-up.
// While the Repository is not followed, the last document stays and `stale` is true.

/** @typedef {import("./diff-target.js").DiffTarget} DiffTarget */
/** @typedef {import("./diff.js").DiffDocument} DiffDocument */
/** @typedef {import("./repository.js").Repository} Repository */
/**
 * The part of the Workbench a live Diff uses.
 * @typedef {{
 *   repository(key: import("./repository.js").RepositoryKey): Repository | undefined,
 *   subscribe(fn: () => void): () => void,
 *   loadDiff(target: DiffTarget): Promise<DiffDocument>,
 * }} DiffSource
 */

/**
 * Starts loading `target` at once and keeps it live until `dispose()`.
 * @param {DiffSource} workbench @param {DiffTarget} target
 */
export function createLiveDiff(workbench, target) {
  /** @type {DiffDocument | null} */
  let doc = null;
  /** @type {string | null} */
  let error = null;
  let disposed = false;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const changed = () => {
    if (!disposed) for (const fn of [...listeners]) fn();
  };

  // One load in flight; reloads asked for meanwhile share one follow-up load.
  /** @type {Promise<void> | null} */
  let running = null;
  /** @type {Promise<void> | null} */
  let followUp = null;
  /** @returns {Promise<void>} */
  function reload() {
    if (disposed) return Promise.resolve();
    if (!running) {
      const load = (async () => {
        /** @type {{ doc: DiffDocument } | { error: string }} */
        let result;
        try {
          // Always asynchronous, so `load` is assigned before it is compared below.
          result = { doc: await Promise.resolve().then(() => workbench.loadDiff(target)) };
        } catch (err) {
          result = { error: String(/** @type {any} */ (err)?.message ?? err) };
        }
        // Cleared before telling listeners, so a reload they ask for starts a new load.
        if (running === load) running = null;
        if (disposed) return;
        if ("doc" in result) {
          doc = result.doc;
          error = null;
        } else error = result.error;
        changed();
      })();
      running = load;
      return load;
    }
    if (!followUp) {
      const next = () => {
        followUp = null;
        return running ?? reload();
      };
      followUp = running.then(next, next);
    }
    return followUp;
  }

  // Following: re-subscribe whenever the Workbench's followed Repositories change.
  /** @type {Repository | undefined} */
  let repository;
  /** @type {(() => void) | null} */
  let offRepository = null;
  function track() {
    const next = workbench.repository(target.repository);
    if (next === repository) return;
    offRepository?.();
    offRepository = null;
    const wasStale = !repository;
    repository = next;
    if (repository) {
      offRepository = repository.subscribe(() => void reload());
      // Followed again (or for the first time since it went stale): catch up.
      if (wasStale && doc) void reload();
    }
    changed();
  }
  const offWorkbench = workbench.subscribe(track);
  track();
  void reload();

  return {
    target,
    /** The last loaded document; null until the first load completes. */
    get doc() {
      return doc;
    },
    /** The last load's error message, or null when it succeeded. */
    get error() {
      return error;
    },
    /** True while the target's Repository is not followed: `doc` is no longer kept current. */
    get stale() {
      return !repository;
    },
    /** True while a load runs. */
    get loading() {
      return running !== null;
    },
    /** Forces a reload (merged with one already running). */
    reload,
    /** Called after every load and every change of `stale`. @param {() => void} fn @returns {() => void} */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Stops following and notifying. */
    dispose() {
      disposed = true;
      offWorkbench();
      offRepository?.();
      listeners.clear();
    },
  };
}

/** @typedef {ReturnType<typeof createLiveDiff>} LiveDiff */
