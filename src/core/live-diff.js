// @ts-check
// A live Diff: the DiffDocument of one Diff target, kept current while its
// Repository is followed. The Diff view owns one per tab.
//
// It looks up `workbench.repository(target.repository)` on every Workbench state
// change and reloads on every snapshot change of that Repository. At most one
// load runs at a time; reloads asked for meanwhile merge into one follow-up.
// While the Repository is not followed, the last document stays and `stale` is true.

import { createSignal, coalesce } from "./signal.js";
import { errorFrom } from "./errors.js";

/** @typedef {import("./diff-target.js").DiffTarget} DiffTarget */
/** @typedef {import("./diff.js").DiffDocument} DiffDocument */
/** @typedef {import("./repository.js").Repository} Repository */
/**
 * The part of the Workbench a live Diff uses.
 * @typedef {{
 *   repository(key: import("./repository-key.js").RepositoryKey): Repository | undefined,
 *   subscribe(fn: () => void): () => void,
 *   loadDiff(target: DiffTarget): Promise<import("./diff.js").DiffResult>,
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
  const changes = createSignal();
  const changed = () => {
    if (!disposed) changes.emit();
  };

  let loading = false;
  const load = coalesce(async () => {
    loading = true;
    try {
      return await workbench.loadDiff(target);
    } catch (err) {
      // GitNotFound / GitTimeout
      return /** @type {const} */ ({ ok: false, error: errorFrom(err) });
    } finally {
      loading = false;
    }
  }, (result) => {
    if (disposed) return;
    if (result.ok) {
      doc = result.doc;
      error = null;
    } else error = result.error.summary;
    changed();
  });
  /** @returns {Promise<void>} */
  const reload = () => (disposed ? Promise.resolve() : load());

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
    /** The last load's error summary, or null when it succeeded. */
    get error() {
      return error;
    },
    /** True while the target's Repository is not followed: `doc` is no longer kept current. */
    get stale() {
      return !repository;
    },
    /** True while a load runs. */
    get loading() {
      return loading;
    },
    /** Forces a reload (merged with one already running). */
    reload,
    /** Called after every load and every change of `stale`. @param {() => void} fn @returns {() => void} */
    onChange: changes.subscribe,
    /** Stops following and notifying. */
    dispose() {
      disposed = true;
      offWorkbench();
      offRepository?.();
      changes.clear();
    },
  };
}

/** @typedef {ReturnType<typeof createLiveDiff>} LiveDiff */
