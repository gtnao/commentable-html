#!/bin/sh
# commentable-html injector.
#
#   sh inject.sh <input.html> [-o output.html] [--merge previous.html]
#
# Reads an ordinary HTML document and writes a NEW single-file document with the
# commenting layer inlined. The input is never modified, and the layer adds no
# external references — the result is one file you can hand to someone.
#
# Comments already stored in a previous output are carried over, so a revised
# document can be re-published without losing the discussion on it.
#
# POSIX sh + awk only. No language runtime, no package manager, nothing to
# install: the build is file concatenation plus two splices. The assets are
# shipped in their final form precisely so that nothing has to be escaped.

set -eu

SELF=$(cd "$(dirname "$0")" && pwd)
ASSETS=$SELF/../assets
USAGE="usage: inject.sh <input.html> [-o out.html] [--merge previous.html]"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- arguments

INPUT=; OUTPUT=; MERGE=
while [ $# -gt 0 ]; do
  case $1 in
    -o|--out)  [ $# -ge 2 ] || die "$1 needs a value"; OUTPUT=$2; shift 2 ;;
    --merge)   [ $# -ge 2 ] || die "$1 needs a value"; MERGE=$2; shift 2 ;;
    -h|--help) printf '%s\n' "$USAGE"; exit 0 ;;
    -*)        die "unknown option: $1" ;;
    *)         [ -z "$INPUT" ] || die "unexpected argument: $1"; INPUT=$1; shift ;;
  esac
done
[ -n "$INPUT" ] || die "$USAGE"
[ -f "$INPUT" ] || die "no such file: $INPUT"

abspath() { case $1 in /*) printf '%s\n' "$1" ;; *) printf '%s\n' "$PWD/$1" ;; esac; }

INPUT=$(abspath "$INPUT")
if [ -z "$OUTPUT" ]; then
  case $INPUT in
    *.html) OUTPUT=${INPUT%.html}.commentable.html ;;
    *.htm)  OUTPUT=${INPUT%.htm}.commentable.html ;;
    *)      OUTPUT=$INPUT.commentable.html ;;
  esac
fi
OUTPUT=$(abspath "$OUTPUT")
[ "$OUTPUT" != "$INPUT" ] || die "refusing to overwrite the source document"

for f in light.css ui.css layer.js; do
  [ -f "$ASSETS/$f" ] || die "missing asset: $ASSETS/$f"
done

TMP=$(mktemp -d "${TMPDIR:-/tmp}/commentable.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

has() { grep -q "$@" 2>/dev/null; }          # never trips `set -e` on no-match

# ------------------------------------------------------- strip a prior layer
#
# Only lines byte-identical to the ones this script emits are removed, so a
# document that merely happens to mention a ch- name keeps its content and is
# caught by the clash check below instead of being silently deleted.

awk '
  BEGIN { skip = "" }
  {
    if (skip != "") { if (index($0, skip) > 0) skip = ""; next }
    c = ""
    if      (index($0, "<style id=\"ch-style\">") > 0)                         c = "</style>"
    else if (index($0, "<style id=\"ch-vars\">") > 0)                          c = "</style>"
    else if (index($0, "<script type=\"text/css\" id=\"ch-ui-css\">") > 0)     c = "</script>"
    else if (index($0, "<script type=\"application/json\" id=\"ch-data\">") > 0) c = "</script>"
    else if (index($0, "<script id=\"ch-app\">") > 0)                          c = "</script>"
    else if (index($0, "<ch-sidebar") > 0)                                     c = "</ch-sidebar>"
    if (c != "") { if (index($0, c) == 0) skip = c; next }
    print
  }
' "$INPUT" > "$TMP/bare.html"

# ------------------------------------------------------------- clash check
#
# The layer occupies a small fixed namespace in the host document: the element
# names ch-sidebar and ch-highlight, ids beginning with ch-, and custom
# properties beginning with --ch-. Nothing is styled by matching the document's
# own selectors, so a collision is possible only if the document already uses
# one of these names. Refuse, rather than bind to the wrong element.

RESERVED='<ch-sidebar[ />]|<ch-highlight[ />]|[[:space:]]id="ch-[A-Za-z0-9_-]*"|[[:space:]]id='\''ch-[A-Za-z0-9_-]*'\''|--ch-[A-Za-z0-9_-]+[[:space:]]*:'
clash=$(grep -n -E -i "$RESERVED" "$TMP/bare.html" | head -1 || true)
if [ -n "$clash" ]; then
  printf 'error: the document already uses a reserved name, at line %s:\n' "${clash%%:*}" >&2
  printf '  %s\n' "$(printf '%s' "$clash" | cut -c1-140)" >&2
  printf 'reserved: <ch-sidebar>, <ch-highlight>, id="ch-*", --ch-*\n' >&2
  printf 'rename it in the source document and retry.\n' >&2
  exit 1
fi

# --------------------------------------------------- carry existing comments

extract_island() {
  [ -f "$1" ] || return 1
  awk '
    index($0, "<script type=\"application/json\" id=\"ch-data\">") > 0 { on = 1; next }
    on && index($0, "</script>") > 0 { exit }
    on { print }
  ' "$1"
}

CARRIED_FROM=
: > "$TMP/store.json"
for cand in "$MERGE" "$INPUT" "$OUTPUT"; do
  [ -n "$cand" ] && [ -f "$cand" ] || continue
  extract_island "$cand" > "$TMP/candidate.json" || continue
  if has '"anchor"' "$TMP/candidate.json"; then
    cp "$TMP/candidate.json" "$TMP/store.json"
    CARRIED_FROM=$(basename "$cand")
    break
  fi
done
[ -s "$TMP/store.json" ] || printf '{\n  "version": 1,\n  "threads": []\n}\n' > "$TMP/store.json"
THREADS=$(grep -c '"anchor"' "$TMP/store.json" || true)

# ----------------------------------------------------------- build the blocks
#
# Every payload is copied verbatim — nothing is escaped, substituted or quoted.
# The UI stylesheet rides along in an inert <script type="text/css"> element
# that the runtime reads with textContent, which is what keeps this a pure
# concatenation instead of a code-generation step.

if has -F '</script' "$ASSETS/ui.css"; then die 'ui.css contains </script and would close its carrier'; fi
if has -F '</script' "$TMP/store.json"; then die 'carried comment data would close its own script tag'; fi

{
  printf '<style id="ch-style">\n'
  cat "$ASSETS/light.css"
  printf '</style>\n'
} > "$TMP/head.part"

{
  printf '<ch-sidebar data-ch-ui></ch-sidebar>\n'
  printf '<script type="text/css" id="ch-ui-css">\n'
  cat "$ASSETS/ui.css"
  printf '</script>\n'
  printf '<script type="application/json" id="ch-data">\n'
  cat "$TMP/store.json"
  printf '</script>\n'
  printf '<script id="ch-app">\n'
  cat "$ASSETS/layer.js"
  printf '</script>\n'
} > "$TMP/body.part"

# ----------------------------------------------------------------- splice in
#
# Insert a payload immediately before the first occurrence of a closing tag,
# splitting the line when the tag does not start it. A bare fragment with no
# such tag gets the payload at the matching edge instead.

place() {  # place <file> <lowercase-closing-tag> <payload> <head|tail>
  if has -i -F -- "$2" "$1"; then
    awk -v tag="$2" -v payload="$3" '
      BEGIN { done = 0 }
      {
        if (!done) {
          p = index(tolower($0), tag)
          if (p > 0) {
            if (p > 1) print substr($0, 1, p - 1)
            while ((getline line < payload) > 0) print line
            close(payload)
            print substr($0, p)
            done = 1
            next
          }
        }
        print
      }
    ' "$1"
  elif [ "$4" = head ]; then
    cat "$3" "$1"
  else
    cat "$1" "$3"
  fi
}

place "$TMP/bare.html"     '</head>' "$TMP/head.part" head > "$TMP/withhead.html"
place "$TMP/withhead.html" '</body>' "$TMP/body.part" tail > "$TMP/out.html"

# -------------------------------------------------------------------- verify
#
# Fail before writing rather than ship a broken file. Each of these has been a
# real bug at some point.

for marker in '<style id="ch-style">' \
              '<script type="text/css" id="ch-ui-css">' \
              '<script type="application/json" id="ch-data">' \
              '<script id="ch-app">' \
              '<ch-sidebar'; do
  n=$(grep -c -F -- "$marker" "$TMP/out.html" || true)
  [ "$n" = 1 ] || die "expected exactly one '$marker' in the output, found $n"
done
if has -F '<ch-highlight ' "$TMP/out.html"; then die 'highlights leaked into the output'; fi

# The layer must never reference anything off-file. The host document's own
# external resources are its business — report them, do not refuse.
for f in "$ASSETS/light.css" "$ASSETS/ui.css"; do
  if has -E -i 'url\(["'"'"']?(https?:|//)' "$f"; then die "asset $f references an external URL"; fi
done
HOST_EXT=$(grep -o -E '(src|href)="[^"]*"' "$TMP/out.html" \
  | grep -E '="(https?:|//)' | sort -u | head -3 || true)

# ------------------------------------------------------------------- deliver

cp "$TMP/out.html" "$OUTPUT"

SIZE=$(wc -c < "$OUTPUT" | awk '{ printf "%.1f", $1 / 1024 }')
printf 'in       %s\n' "$INPUT"
printf 'out      %s\n' "$OUTPUT"
printf 'size     %s KB\n' "$SIZE"
if [ -n "$CARRIED_FROM" ]; then
  printf 'threads  %s (carried from %s)\n' "$THREADS" "$CARRIED_FROM"
else
  printf 'threads  %s\n' "$THREADS"
fi
printf 'checks   single layer, layer self-contained, source untouched\n'
if [ -n "$HOST_EXT" ]; then
  printf 'note     the source document loads external resources of its own; they\n'
  printf '         will not work offline:\n'
  printf '%s\n' "$HOST_EXT" | sed 's/^/           /'
fi
