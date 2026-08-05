# commentable-html — internals

Read this only when modifying the layer. Using the skill needs nothing here.

```
assets/light.css   the only CSS injected into the host document
assets/ui.css      shadow-root CSS, carried in an inert script element
assets/layer.js    the runtime
scripts/inject.sh  build step; concatenates everything into one file
```

## Dependencies

None. `inject.sh` is POSIX sh plus awk, sed, grep and wc — no language
runtime, no package manager, no manifest. Verified against `sh`, `dash` and
`zsh`.

That is a design constraint, not a coincidence. `ui.css` is carried in an
inert `<script type="text/css" id="ch-ui-css">` element and read back with
`textContent`, rather than being escaped into a JavaScript string literal.
That single decision is what reduces the build to concatenation: no payload is
ever quoted, substituted, or escaped, so no runtime is needed to do it. Keep
it that way — the moment an asset has to be embedded *inside* another asset,
the dependency comes back.

`inject.sh` splices `<style id="ch-style">` before `</head>`, and
`<ch-sidebar>`, `<script id="ch-ui-css">`, `<script id="ch-data">`,
`<script id="ch-app">` before `</body>`. A document with neither tag (a bare
fragment) gets each block at the matching edge.

Re-injection strips a previous layer first, matching only lines byte-identical
to the ones it emits, so a second pass is byte-identical to the first.

## Storage model

`#ch-data` is a `<script type="application/json">` island and the single source
of truth:

```json
{ "version": 1,
  "threads": [
    { "id": "t-…",
      "anchor": { "quote": "…", "prefix": "…", "suffix": "…", "start": 0, "end": 0 },
      "messages": [ { "id": "m-…", "author": "…", "text": "…", "at": "ISO", "editedAt": "ISO?" } ] }
  ] }
```

`<` is escaped to `<` so user text can never close the script tag.

Highlights and the sidebar are **rendered from this on every load and never
serialized**. That is what makes saving idempotent: save → reload → save
produces byte-identical output. Re-injection is idempotent for the same
reason. Check both after any change here.

Anything that mutates the DOM at runtime must be undone in `serializeSelf()`:

| runtime mutation | undone by |
|---|---|
| `<ch-highlight>` wrappers | `unwrapMarks(clone)` |
| `<style id="ch-vars">` palette | removed from the clone |
| shadow UI | not cloned by `cloneNode` — nothing to do |
| inline gutter on `<body>` | original `style` attribute restored |
| trailing whitespace in `<body>` | normalised, or each save grows a byte |

## Re-anchoring

`buildIndex()` flattens the host document's text (skipping `script`, `style`,
`noscript`, `template`, `svg`, and anything under `[data-ch-ui]`) and keeps a
node/offset map back into it.

`resolveAnchor()` tries, in order:

1. exact match at the stored offsets
2. every occurrence of the quote, scored by how much of the stored prefix and
   suffix still match, with proximity to the old offset as a tie-breaker
3. whitespace-normalised search
4. give up — the thread becomes an orphan, listed at the bottom, never deleted

On save, anchors are rewritten from wherever they currently resolve, so drift
does not accumulate across a long series of edits.

`paint()` rebuilds the index per call, because wrapping splits text nodes and a
stale index would drift. Pieces are wrapped back-to-front for the same reason.

## Isolation

The rule is **structural, not cascade-based**. There is no `!important` in
`light.css` and there must not be.

- The two elements the host's CSS could see are custom element names
  (`ch-sidebar`, `ch-highlight`). A document can only style those by writing
  the tag name, which the injector's clash check refuses to allow.
- Selectors carry an attribute (`ch-highlight[data-ch-id]`, 0-1-1) purely to
  stay above a host's `body *` catch-all (0-0-1).
- All UI lives in a shadow root with `:host { all: initial }`, so host CSS
  cannot reach in and shadow ids/classes cannot collide with the document.
- The body gutter is the one unavoidable intrusion into host layout. It is an
  inline style set with `'important'` priority — the top of the author cascade,
  deterministic rather than a specificity gamble — and it is stripped on save.

The clash check reserves exactly three things: the two element names, `ch-`
ids, `--ch-` custom properties. Widening that namespace weakens the guarantee;
keep it this small.

## Runtime state

One composer at a time: `composer = {mode: 'new'|'reply'|'edit', threadId,
msgId, text, author}`. The mounted textarea is the live truth; `composer` is
the snapshot that survives a re-render (a resize or a late webfont triggers
one, and losing half-typed text to that was a real bug).

Every mutation goes through `requireTarget()`. Without a file handle the change
would only exist in memory, so creating, replying, editing and deleting are all
refused the same way — the setup panel shakes instead.

## Sidebar layout

Cards are positioned in document coordinates inside a clipped viewport whose
inner layer is translated by `-(scrollY + viewportTop)`, so they scroll with
the text. `layoutCards()` sorts by anchor position and cascades to avoid
overlap. The card with an open editor takes priority and is clamped inside the
visible strip — otherwise a comment anchored near the end of the document opens
its input below the footer, out of reach.

## Browser constraints that shaped this

- A page cannot get a `FileSystemFileHandle` to itself. Handles come only from
  a picker, drag-and-drop, or `launchQueue`. Hence the drop step.
- Write permission always costs one prompt; it cannot be pre-granted.
- Handles do not survive a reload, so the drop repeats per page load.
- Events from a shadow root are retargeted to the host at `document` level —
  use `composedPath()`, not `event.target`, to tell UI clicks from page clicks.
