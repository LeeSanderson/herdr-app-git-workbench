// A platform with hand-fired file watches and a hand-advanced clock, for the
// live-refresh and Graph refresh tests. Everything else is the real Node platform.
import { samePath } from "./repo.js";
import { createWorkbench } from "../../src/core/workbench.js";
import { nodePlatform } from "../../src/adapters/node-platform.js";

/** Lets pending promise chains and I/O callbacks run. */
export const settle = () => new Promise((r) => setImmediate(r));

/**
 * A platform with a hand-fired `watch` and a hand-advanced `sleep`; everything
 * else is real. `watches` records every watch made: `{path, fire(paths), cancelled}`.
 */
export function fakePlatform() {
  /** @type {{ path: string, fire(paths: string[]): void, fail(err: Error): void, cancelled: boolean }[]} */
  const watches = [];
  /** @type {(() => void)[]} */
  const sleepers = [];
  const platform = {
    ...nodePlatform,
    watch(dir) {
      const queue = [];
      let wake = null;
      let failure = null;
      const w = {
        path: dir,
        cancelled: false,
        fire(paths) {
          queue.push(paths);
          wake?.();
        },
        /** Makes the watch reject, as watchFolder does past its folder limit. */
        fail(err) {
          failure = err;
          wake?.();
        },
      };
      watches.push(w);
      return {
        events: (async function* () {
          while (!w.cancelled) {
            if (!queue.length && !failure) await new Promise((r) => (wake = r));
            wake = null;
            if (failure) throw failure;
            while (queue.length && !w.cancelled) yield queue.shift();
          }
        })(),
        cancel() {
          w.cancelled = true;
          wake?.();
        },
      };
    },
    sleep: (ms) => new Promise((r) => sleepers.push(Object.assign(r, { ms }))),
  };
  return {
    platform,
    watches,
    /** Sleeps waiting to be woken. */
    get sleeping() {
      return sleepers.length;
    },
    /** The durations (ms) of the sleeps waiting to be woken. */
    get sleeps() {
      return sleepers.map((s) => s.ms);
    },
    /** Wakes every pending sleep, then lets the core run on. */
    async tick() {
      for (const r of sleepers.splice(0)) r();
      await settle();
    },
  };
}

/** Follows `folder` and counts the Repository's refreshes from then on. */
export async function followCounting(fake, folder) {
  const workbench = createWorkbench(fake.platform);
  await workbench.follow({ machine: null, folder });
  const repository = workbench.state.repository;
  const counter = { workbench, repository, refreshes: 0, next: null };
  let resolveNext;
  counter.next = new Promise((r) => (resolveNext = r));
  repository.subscribe(() => {
    counter.refreshes++;
    resolveNext();
    counter.next = new Promise((r) => (resolveNext = r));
  });
  return counter;
}

/** Ticks the fake clock until a refresh lands (or gives up after ~15 s; git is slow on a busy machine). */
export async function untilRefreshed(fake, counter) {
  const before = counter.refreshes;
  for (let i = 0; i < 300 && counter.refreshes === before; i++) {
    await fake.tick();
    await Promise.race([counter.next, new Promise((r) => setTimeout(r, 50))]);
  }
}

/** Ticks a few times and waits a little, so anything scheduled would have run. */
export async function quiet(fake) {
  for (let i = 0; i < 5; i++) {
    await fake.tick();
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The live (not cancelled) watch on `dir`. */
export const watchOf = (fake, dir) => fake.watches.find((w) => samePath(w.path, dir) && !w.cancelled);
