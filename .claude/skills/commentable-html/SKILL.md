---
name: commentable-html
description: Turn a plain HTML document into a single-file HTML that readers can comment on — select text, leave a threaded comment in a right-hand sidebar, save back into the same file. Use when sharing an HTML write-up (a doc, report, design memo, or explainer written as HTML instead of Markdown) and someone needs to leave feedback on it, or when asked to make an HTML "commentable", add comments/review/annotation to an HTML file, or re-publish an updated document while keeping the comments already on it.
---

# commentable-html

Wraps an existing HTML document with a commenting layer and writes a **new**
single-file document. The source is never modified.

The layer is a fixed asset, not something to re-author. Run the script.

## Do this

```bash
sh .claude/skills/commentable-html/scripts/inject.sh <input.html>
```

POSIX sh and awk — nothing to install, no language runtime. The file it
produces needs only a browser: no CDN, no fonts, no network.

Writes `<input>.commentable.html` next to the source. Options:

| flag | meaning |
|---|---|
| `-o <path>` | output path (default `<input>.commentable.html`) |
| `--merge <previous.html>` | carry comments over from an earlier published file |

The script verifies its own output before writing and exits non-zero on any
problem. If it exits 0, the file is self-contained and correct — do not
re-inspect it, and never hand-edit the generated file.

1. Resolve the input path. If the user did not name a file and more than one
   `.html` is plausible, ask which one. Do not guess.
2. Run the command.
3. Report the output path and the three usage steps below.

## What to tell the user

The reader must link the file before commenting — a browser cannot obtain a
write handle to its own file without one explicit user gesture. Say exactly
this much:

1. Open the generated file in **Chrome or Edge** (Firefox/Safari cannot save).
2. Drag the file itself onto the page once, to enable saving.
3. Select text to comment. Saving is automatic from then on.

Comments live inside the HTML, so the file can be passed on and the comments
travel with it.

## Republishing after the document changed

Edit the **original** source, then:

```bash
sh .claude/skills/commentable-html/scripts/inject.sh <input.html> --merge <previous.commentable.html> -o <previous.commentable.html>
```

Comments re-anchor to their quoted text. Any whose text no longer exists are
kept and listed as "位置が特定できないコメント" at the bottom of the sidebar —
they are never dropped.

## When the script refuses

`the document already uses ... the comment layer reserves the ch- namespace`

The source already occupies a reserved name: an element `ch-sidebar` /
`ch-highlight`, an `id` starting with `ch-`, or a custom property starting with
`--ch-`. This is a guarantee, not an obstacle: injection only ever proceeds
when a collision is impossible.

Fix by renaming the conflicting name **in the source document**, then re-run.
Rename the document's own identifier — never the layer's.

## Limits worth stating if asked

- Chrome / Edge only. The File System Access API has no substitute elsewhere.
- One drag-and-drop per page load, plus one browser permission prompt.
- `transform` or `filter` on `<html>`/`<body>` breaks the sidebar's fixed
  positioning. The layer detects this and warns in its footer.
- Text inside `<svg>` cannot be commented on.

`reference.md` in this skill directory documents the architecture, the
re-anchoring algorithm, and the isolation guarantees. Read it only when
changing the layer itself.
