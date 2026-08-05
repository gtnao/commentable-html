# commentable-html

A Claude Code skill that turns any HTML document into a single file people can
comment on — select text, leave a threaded comment in the margin, and the
comment is written back into the HTML itself.

LLMs increasingly hand you an HTML page instead of a Markdown file. Those pages
are pleasant to read and impossible to give feedback on. This closes that gap
without a server, an account, or a second tool.

<video src="./commentable-html.mp4" controls width="720"></video>

[commentable-html.mp4](./commentable-html.mp4) — walkthrough.

## Use it

```bash
sh .claude/skills/commentable-html/scripts/inject.sh doc.html
```

Writes `doc.commentable.html`. The source is never modified.

Open the result in Chrome or Edge, drop the file onto its own page once to
grant write access, then select text to comment. Saving is automatic from then
on. Hand the file to anyone — the comments travel inside it.

To republish after editing the document, carrying the discussion over:

```bash
sh .claude/skills/commentable-html/scripts/inject.sh doc.html \
   --merge doc.commentable.html -o doc.commentable.html
```

Comments re-anchor to their quoted text. Any whose text no longer exists are
kept and listed separately rather than dropped.

## How it holds together

**No dependencies.** The injector is POSIX `sh` and `awk` — no runtime, no
package manager, no manifest. The build is file concatenation, because the UI
stylesheet rides in an inert `<script type="text/css">` element instead of
being escaped into a JavaScript string. The generated page loads nothing over
the network.

**Comments live in the file.** A JSON island is the only source of truth.
Highlights and the sidebar are rendered from it on load and never serialized,
so save → reload → save is byte-identical, and re-injecting is too.

**Anchors survive edits.** Each comment stores its quote, the surrounding
context, and a character offset. On load they are matched in that order of
preference; a quote that has genuinely disappeared becomes an orphan, never a
deletion.

**Isolation is structural, not a specificity fight.** The two elements the host
document could style are custom element names, everything else lives in a
shadow root, and there is no `!important` anywhere in the injected CSS. The
injector refuses to run if the document already uses the `ch-` namespace — so
injection succeeding *is* the guarantee that nothing collides.

## Limits

- Chrome / Edge only; the File System Access API has no substitute elsewhere.
- One drag-and-drop and one permission prompt per page load.
- `transform` or `filter` on `<html>`/`<body>` breaks the sidebar's fixed
  positioning. The layer detects this and says so.
- Text inside `<svg>` cannot be commented on.

`.claude/skills/commentable-html/reference.md` documents the internals.
