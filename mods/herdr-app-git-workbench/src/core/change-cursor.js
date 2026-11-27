// @ts-check
// The Diff view's change cursor: which change block the navigator is on.

/** Starts on no change (-1). */
export function createChangeCursor() {
  let current = -1;
  let seen = false;
  return {
    /** The current change block's index, or -1 before the first jump. */
    get current() {
      return current;
    },
    /**
     * A document with `count` changes loaded. The first load goes to Change 1;
     * later loads (live reloads) leave the cursor where it is.
     * @param {number} count @returns {boolean} whether the cursor moved, so the view should bring it into view
     */
    loaded(count) {
      if (seen) return false;
      seen = true;
      if (!count) return false;
      current = 0;
      return true;
    },
    /**
     * Moves `delta` changes among `count`, wrapping from last to first. Before
     * the first jump (or when out of range), next goes to the first change and
     * previous to the last.
     * @param {1 | -1} delta @param {number} count @returns {boolean} whether there was a change to go to
     */
    go(delta, count) {
      if (!count) return false;
      current = current < 0 || current >= count
        ? (delta > 0 ? 0 : count - 1)
        : (current + delta + count) % count;
      return true;
    },
  };
}
