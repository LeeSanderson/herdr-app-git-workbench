// @ts-check
// Where the Workbench looks for the Repository in the shown ("active") space:
// the folder of its last focused terminal, else where its terminals are now
// (shown tab first), else the folder the space started in.
//
// A space's `folder` is only where its new terminals start; a terminal can move
// on (`cd`), and Herdr then names the space after where its first terminal is
// now. Following the terminals keeps the Repository in step with that name. A
// mod pane (such as the panel itself) has no cwd, so each space's last focused
// terminal folder is remembered while the space exists.

/**
 * @typedef {{ machine: string | null, folder: string }} Place
 * @typedef {{ id: string, folder: string, machine?: string | null, active: boolean, tabs?: { id: string, active: boolean }[] }} Space
 * @typedef {{ space: string, cwd: string | null }} Focus
 * @typedef {{ tab: string, terminal: string | null, cwd: string | null }} Pane
 */

export function createPlaceTracker() {
  /** Each space's last focused terminal folder, by space id. @type {Map<string, string>} */
  const lastCwd = new Map();

  /** The folder of the first terminal in `space`, its shown tab first. @param {Space} space @param {Pane[]} panes */
  function terminalFolder(space, panes) {
    const tabs = [...(space.tabs ?? [])].sort((a, b) => Number(b.active) - Number(a.active));
    for (const tab of tabs) {
      const pane = panes.find((p) => p.tab === tab.id && p.terminal != null && p.cwd);
      if (pane?.cwd) return pane.cwd;
    }
    return null;
  }

  return {
    /**
     * The place to follow now, or null when no space is shown. An empty folder
     * means home: `home` on this computer, "" (its own home) on another machine.
     * @param {Space[]} spaces @param {Focus | null} focused @param {Pane[]} panes @param {string} home
     * @returns {Place | null}
     */
    whereToFollow(spaces, focused, panes, home) {
      for (const id of lastCwd.keys()) if (!spaces.some((s) => s.id === id)) lastCwd.delete(id);
      const space = spaces.find((s) => s.active);
      if (!space) return null;
      if (focused && focused.space === space.id && focused.cwd) lastCwd.set(space.id, focused.cwd);
      const machine = space.machine ?? null;
      const folder = lastCwd.get(space.id) || terminalFolder(space, panes) || space.folder || (machine == null ? home : "");
      return { machine, folder };
    },
  };
}
