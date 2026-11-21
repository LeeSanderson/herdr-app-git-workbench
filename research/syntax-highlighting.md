# Syntax highlighting for custom Diff view rows

Research for issue #11. Target: Herdr Desktop (herdr-app 0.1.16) JavaScript mods.
Sources are the API refs shipped with the app in `~/.config/herdr-app/`
(`gpui-kit.d.ts`, `herdr.d.ts`, `AGENTS.md`) and the shipped mods in
`~/.config/herdr-app/mods/`. Line numbers are from those files as installed.

## Answer

**No host tokenizer or highlighter is exposed to mods.** The only syntax
highlighting in the API is inside `EditorState`/`Editor`, and it does not give
spans back to JavaScript. Styled spans per line are still *possible*, but only
by tokenizing in mod JavaScript ourselves and drawing each token as a coloured
`div` inside the row. That runs on the UI thread, so it must be done lazily for
visible rows only.

Recommendation: **Phase 1 ships without syntax highlighting** (added/removed
backgrounds only, as the shipped `changes` mod does). The fallback is needed.
A JS lexer for visible rows is a viable Phase 2 add-on and does not change the
row model.

## Evidence

### The only highlighter is sealed inside `EditorState`

- `gpui-kit.d.ts:21489-21525` (module `gpui-base`): `EditorState` exposes only
  `value()`, `set_value()`, `selected_range()`, `set_selected_range()`,
  `replace()`, `on()`, `focus()`, `release()`. The constructor takes
  `language?: string` and `syntax?: Record<string, string>` (semantic colours:
  keyword, string, comment, function, type, number, constant, variable,
  operator, punctuation, boolean, string.escape; `:21519-21522`). There is no
  method returning tokens, highlight ranges or styled runs.
- `AGENTS.md:1049-1054` describes `EditorState` + `Editor` as "a code view
  (readonly) or editor with syntax highlighting, line numbers and folding". No
  other highlighting surface is documented.
- Grep of `gpui-kit.d.ts` (all modules: `gpui-kit`, `gpui`, `gpui-base`,
  `gpui-component`, `gpui-shell`, `gpui-fps`, node-like built-ins) for
  `highlight|tokeniz|syntax|tree.?sitter|StyledText|TextRun|language` finds only
  the `EditorState` options above plus unrelated UI "highlighted option" docs
  (`:211`, `:936`, `:1024`, `:21163-21173`) and a comment at `:21302`.
- Grep of `herdr.d.ts` for the same terms: no matches.
- `InlineTokenSpan` (`gpui-kit.d.ts:20710`, `:22000`) is for chip-like tokens
  inside `InputState`/`TextareaState`, not syntax tokens.
- `TextView.html(id, html)` / `TextView.markdown(id, markdown)`
  (`gpui-kit.d.ts:20737-20747`) render rich text; "CSS in HTML is not
  supported", so it cannot be used to colour arbitrary spans. Whether fenced
  code blocks in markdown get highlighted is undocumented, and it would not
  fit a 20 px virtual-list row anyway.

### Shipped mods confirm it

- `mods/files/main.js:141-144` uses `EditorState.new({ language, readonly: true,
  syntax: {...} })` for its file viewer — the only highlighting in any shipped
  mod (grep of `mods/**` excluding `.d.ts`).
- `mods/changes/main.js:171-205` draws its diff as custom 20 px rows in
  `v_virtual_list` with plain `text_color(...)` per row and no syntax colour.

### What we *can* build with: styled spans as child divs

Per-token styling is available on any element:

- `text_color(value: Color)` — `gpui-kit.d.ts:1458`
- `font_weight(value: number)` — `:1376`; `italic()` — `:5837`
- `font_family(value: string)` — `:1374`; `whitespace_nowrap()` — `:20295`
- `h_flex()` — `:20725`, `div()` — `:20299`

So a row is `h_flex().children(tokens.map(t => div().text_color(colour[t.kind]).child(t.text)))`.

Mods can ship extra modules (`AGENTS.md:876-880`: `*.js ... more modules
("./ui.js")`), so a lexer can be vendored as a local ES module (hand-written
regex lexer, or a vendored pure-JS highlighter). Bare npm imports are not
documented; files would need to be copied in.

### Cost and blocking

- There is no worker/background thread for JS. `cx.spawn(body, opts?)`
  (`gpui-kit.d.ts:384`), `cx.sleep(ms?)` ("Resolves after `ms` on GPUI's
  foreground executor", `:386-387`) and `cx.timer.after/every`
  (`:20648-20653`) all run on the foreground executor. Grep for
  `worker|background_executor|yield|setTimeout` finds nothing. Any tokenizing
  done in JS blocks the UI for its duration.
- `v_virtual_list(id, item_count, item_sizes, get_key, render)`
  (`gpui-kit.d.ts:21313-21319`) calls `render` with only the visible range and
  is documented as cheap for "a uniform hundred thousand rows" (`:21302-21303`).
  So per-line tokenizing inside `render`, with a `Map<lineIndex, tokens>` cache,
  costs O(visible rows) per frame (roughly 30-60 lines), independent of file size.
- Catch: multi-line constructs (block comments, template/triple-quoted
  strings) need the lexer state at the start of each line. Options:
  1. Ignore cross-line state (each line lexed alone). Cheap, occasionally wrong
     inside block comments. Diff hunks are already partial context, so a real
     highlighter is also imperfect there.
  2. One linear state pass per side of the diff, chunked across
     `await cx.sleep(0)` yields inside `cx.spawn`, then lex lines lazily.
     A simple regex state scan is on the order of milliseconds per 10k lines,
     but this is an estimate, not measured in Herdr.
- Alternative: `exec(command, args, { cwd, on, timeout })` (`herdr.d.ts:14`)
  could run an external highlighter (e.g. `bat --color=always`) and parse ANSI.
  It runs off-thread, but the tool is not guaranteed to be installed, and
  remote machines would also need it. Not recommended as a default.

## Conclusion

| Option | Available? | Cost |
| --- | --- | --- |
| Host tokenizer/highlighter API | No | — |
| `EditorState` highlighting | Yes, but no spans out, no line decorations | — |
| JS lexer + coloured child divs per row | Yes (build it ourselves) | O(visible rows) per frame if lazy; UI thread only |
| External `bat`/similar via `exec` | Possible | Dependency on user install; ANSI parsing |

Phase 1: no syntax highlighting; added/removed row backgrounds only.
Phase 2 candidate: a small vendored per-line JS lexer for common languages,
applied lazily in the `v_virtual_list` render callback, with a per-line cache.
