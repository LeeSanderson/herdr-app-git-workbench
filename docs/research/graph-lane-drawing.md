# Can Herdr / gpui-kit draw the commit lane graph?

Research for #36 (part of #35). Question: what drawing primitives can a mod use for a
VS Code-style commit lane graph in a list row, and does the list support virtualised rows,
tooltips/hover cards and badges?

## Sources

The type files are the authority. Herdr's own mod guide says so: "the type files here are the
truth: `gpui-kit.d.ts` for elements and `herdr.d.ts` for the app's data and commands. They're
rewritten on every start to match this version" (`~/.config/herdr-app/AGENTS.md:45-51`).

- `C:\Users\leeco\.config\herdr-app\gpui-kit.d.ts` (herdr-app 0.1.18, written 2026-11-24)
- `C:\Users\leeco\.config\herdr-app\herdr.d.ts` (same version)
- `C:\Users\leeco\.config\herdr-app\AGENTS.md` (the installed copy of the Herdr mod guide)
- `C:\Users\leeco\.config\herdr-app\mods\win98\kit.js` (a shipped mod that uses `paint_path`)
- This repo's `src/ui/diff-view.js` and `src/ui/source-control-panel.js` (how we already use the APIs)
- https://gpui-kit.com: the home page mentions only virtualised lists (`VirtualList`, `List`). It does not document vector drawing, tooltips or badges. The local `.d.ts` has more.

Line numbers below are for `gpui-kit.d.ts` unless another file is named.

## Short answer

**Yes. Real vector drawing is available.** gpui-kit exposes GPUI's `PathBuilder` (lines, quadratic and
cubic Béziers, arcs, polygons, stroke or fill, dashes) and `window.paint_path(path, colour)`,
which returns an ordinary element. Put a fixed-size `relative()` graph cell in each row of a
fixed-height `v_virtual_list`. In the cell, put one absolutely positioned `paint_path` layer for
each lane colour. Use `theme().ansi*` colours. This gives a true VS Code-style graph with curved
merge and branch connectors, and it is not limited to box-drawing glyphs.

## 1. Vector drawing: `PathBuilder` and `window.paint_path`

- `PathBuilder.fill()` / `PathBuilder.stroke(width)` start a builder (lines 20436-20439).
- Builder methods (lines 20425-20435): `move_to`, `line_to`, `curve_to` (quadratic, one control
  point), `cubic_bezier_to` (two control points), `arc_to` (SVG-style elliptical arc),
  `add_polygon(points, closed?)`, `close()`, `dash_array(values)`, `build()`, which returns an
  immutable `Path` (line 20423).
- Coordinates are `PathCoordinate = number | \`${number}%\``: "pixels or as a percentage of the
  painted bounds" (lines 22134-22135). Percentages let a row's path scale with the cell.
- `window.paint_path(path, background: Background | Color): NativeElement` (lines 20521-20530):
  "Paints immutable GPUI geometry with a reusable native `Background`… Legal from `render`… it
  builds a description like any other element."
- `window` is a global, so a mod does not import it (lines 22362-22375).
- `Background` (lines 20440-20451): `solid(color)`, `linear_gradient`, `pattern_slash`,
  `checkerboard`, `.opacity()`. `Color` is a `#hex` string (line 68).
- Precedent: the shipped Win98 mod builds a rectangle with `PathBuilder` and layers it with
  `window.paint_path(RECT(), Background.linear_gradient(...)).absolute().top(0).left(0).size_full()`
  (`mods/win98/kit.js:190-199`).

**One colour per path.** `paint_path` takes one background, so each lane colour needs its own
`Path` and its own `paint_path` layer. Stack the layers inside a `relative()` cell.

**Zoom caveat (unverified).** Win98 multiplies its checkerboard size by `settings().zoom`
(`kit.js:199`). This suggests that sizes inside a `Background` are in window px. Stroke width may
behave the same way, so test stroke width at zoom levels other than 1. Percentage coordinates
avoid the problem for positions.

### Other shape options

- `svg(path)` and `image(path)` (lines 20321-20338) load **files** from the app directory. `svg`
  is tinted with the text colour. They are good for fixed glyphs (commit dot variants, icons).
  They are not suitable for per-row generated geometry.
- Plain `div`s already give absolute positioning (`.absolute().top().left()`, `inset_0`, `%`
  lengths; see `diff-view.js:438`), `.rounded(n)` / `rounded_full`, borders and `bg`. This is
  enough for vertical lane lines and dots, but not for diagonals or curves.

## 2. Rows: virtualised, fixed height

Three lazy lists are available (AGENTS.md:1130-1135):

| API | Module | Row height | Cost |
|---|---|---|---|
| `v_virtual_list(id, count, item_sizes, get_key, render(range))` (21364-21370) | `gpui-base` | You state it: one number, or one number per row | One host call per frame |
| `uniform_list(id, count, get_key, render(range))` (20416-20421) | `gpui-kit` | Measures the first row and uses that height for every row | One host call per frame |
| `list(id, count, get_key, render(index))` (20392-20397) | `gpui-kit` | Measures each row | One host call per visible row |

For the graph, use **`v_virtual_list` with one fixed row height**. The diff view already does
this (`src/ui/diff-view.js:403-414`, with a paired `Scrollbar.vertical(...).absolute().inset_0()`).
A fixed, known row height is also what the lane geometry needs: each row's connectors join
the rows above and below at y = 0% and y = 100%.

Rules for the renderer, enforced at run time (lines 21321-21328):
- **No handlers in rows.** `on_click` and the other handlers throw there. Use list-level
  `on_item_click(key, cx)` (lines 875-895) and `on_item_secondary_click(key, event, cx)`
  (lines 896-916) instead.
- **No state in rows.** No `focus_handle`, no `InputState`, and no `cx.notify()`.
- The list needs a definite height from its container (lines 20351-20352, AGENTS.md:1131-1133).

`paint_path` is neither a handler nor state. It "builds a description like any other element",
so it is expected to be legal inside the renderer. **No one has run this inside a virtual list
yet**, so confirm it with `herdr-app check` and in the app (AGENTS.md:58-62). Build the paths
inside the renderer from precomputed lane data. Do the lane layout once per log load, not per frame.

## 3. Theme colours

`theme()` returns every colour by name (`herdr.d.ts:341-346`): `background`, `surface`,
`canvas`, `chrome`, `popover`, `raised`, `hover`, `selected`, `border`, `foreground`, `muted`,
`dim`, `accent`, `selection`, status colours, and **`ansi0`..`ansi15`**. Light and dark themes
use the same names. Cycle lane colours through a fixed subset of ANSI slots, for example
`ansi1..6` and `ansi9..14`, so that the graph follows the user's theme (AGENTS.md:1089). The repo
already makes translucent tints with `t[slot] + "33"` (`diff-view.js:321`).

## 4. Tooltips, hover cards, badges

- **Tooltip:** `.tooltip(text: string)` on a `div` / `h_flex` / `v_flex` / `Button` (lines
  967-989). It takes a string only. The shell draws it after a 0.5 s hover, in theme styling.
  **Unverified:** whether `.tooltip` is allowed inside a virtual-list renderer. It is a hover
  behaviour, and the renderer forbids handlers. Test it. If it throws, show details on
  selection (`on_item_click`) in a detail pane instead.
- **Hover card:** `HoverCard` (lines 21161-21169) opens a rich card after `open_delay` and
  closes after `close_delay`. `Popover` (21144-21160) and `Popup.new(id, trigger)`
  (21171-21196) are related. `HoverCard` "owns its own open state". That probably conflicts with
  the "no state inside the renderer" rule, so expect it to fail in virtual rows. A safer
  design: on row click or selection, open a `Popup` or detail panel outside the list.
- **Badges / pills:** there is no `Badge`, `Tag` or `Pill` component. The `Avatar` docs say
  "ordinary children… is where a status dot or a badge goes" (line 20842-20843). Draw pills as
  styled divs, as the repo already does: `div().px(6).h(18).rounded(9).text_size(11).bg(c+"33").text_color(c)`
  (`source-control-panel.js:516`, `diff-view.js:321`). Use these for branch, tag and HEAD refs.

## 5. Fallbacks (if `paint_path` fails in rows)

1. **Absolutely positioned div segments.** Each lane's vertical line is a narrow full-height
   `div` at `left = lane * laneW`. The commit dot is a `rounded_full()` div. A connector to
   another lane can be an L-shape: a half-height vertical div plus a horizontal div, with one
   `rounded` corner made from a bordered div (`border_l/border_b` with `rounded_bl`). This
   reads well, but there are no true diagonals.
2. **Box-drawing glyphs** (`│ ─ ╭ ╮ ╯ ╰ ┼ ●`) in a monospace text run, coloured per glyph with
   `text_color`. This is the simplest option and it is zoom-safe. It looks like `git log --graph`,
   not VS Code.

Recommendation order: `paint_path` per lane colour, then div segments, then glyphs.

## Open runtime checks

1. Can `window.paint_path` be called inside a `v_virtual_list` renderer? Does `herdr-app check` pass with it?
2. Does stroke width scale with `settings().zoom`, or is it in window px?
3. Can `.tooltip(...)` be used inside a virtual-list row?
4. Performance with ~12 `paint_path` layers × ~40 visible rows while scrolling.
