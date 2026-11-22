# herdr-app-git-workbench
Git source control, history and visual diff tools for Herdr Desktop.

## Development

The mod runs from a copy in `~/.config/herdr-app/mods/herdr-app-git-workbench`,
kept in step with this repo by a sync script. A directory junction does not
work: Herdr's hot reload ignores saves made behind one.

```sh
npm run dev      # mirror the mod files, then copy on every save (hot reload)
npm run sync     # one-off mirror
herdr-app check ~/.config/herdr-app/mods/herdr-app-git-workbench
herdr-app do mod.open '{"name":"herdr-app-git-workbench"}'   # show it as an overlay
herdr-app shot shot.png
```
