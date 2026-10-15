#!/usr/bin/env bash
# InfraLens sync - clone or pull every repository listed in repos.txt.
# Twin of sync.cmd for Git Bash / macOS / Linux. Same workspace layout, same
# sync-status.json, so the dashboard shows the result either way.
#
#   ./sync.sh [workspace] [--no-open]      default workspace: ~/infralens-workspace
#
# After pulling, every file of the workspace is written into estate.js next to
# index.html, so opening index.html shows the estate with no folder picking.
#   ./sync.sh --build-only [workspace]     only rebuild estate.js (no git)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WS=""; NOOPEN=""; BUILDONLY=""
for a in "$@"; do case "$a" in --no-open) NOOPEN=1 ;; --build-only) BUILDONLY=1 ;; *) WS="$a" ;; esac; done
WS="${WS:-$HOME/infralens-workspace}"
command -v cygpath >/dev/null 2>&1 && WS="$(cygpath -u "$WS")"   # Git Bash: accept C:\... paths
mkdir -p "$WS"
REPOS="$WS/repos.txt"; STATUS="$WS/sync-status.json"; LOG="$WS/sync.log"; ESTATE="$HERE/estate.js"

# Write estate.js: { name, generated_at, workspace, files: [{path, text}] }.
# Pure awk so it runs anywhere Git Bash runs. .git, .terraform, node_modules skipped.
build_estate() {
  LIST="$(mktemp 2>/dev/null || echo "$WS/.infralens-files.tmp")"
  ( cd "$WS" && find . \( -name .git -o -name node_modules -o -name .terraform \) -prune -o -type f \( -name '*.tf' -o -name '*.tfvars' -o -name '*.json' -o -name '*.yaml' -o -name '*.yml' -o -name '*.hcl' -o -name '*.md' -o -name '*.txt' \) -print | sed 's|^\./||' | sort ) > "$LIST"
  awk -v name="$(basename "$WS")" -v when="$(date '+%Y-%m-%dT%H:%M:%S')" -v ws="$WS" -v list="$LIST" '
    function esc(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); gsub(/\t/, "\\t", s); gsub(/\r/, "\\r", s); gsub(/[\001-\010\013\014\016-\037]/, "", s); return s }
    BEGIN {
      printf "window.__INFRALENS_ESTATE__ = {\"name\":\"%s\",\"generated_at\":\"%s\",\"workspace\":\"%s\",\"files\":[", esc(name), when, esc(ws)
      n = 0
      while ((getline p < list) > 0) {
        f = ws "/" p; text = ""; first = 1
        while ((getline line < f) > 0) { text = text (first ? "" : "\\n") esc(line); first = 0 }
        close(f)
        printf "%s{\"path\":\"%s\",\"text\":\"%s\"}", (n ? "," : ""), esc(p), text
        n++
      }
      print "]};"
      printf "%d", n > "/dev/stderr"
    }' > "$ESTATE" 2> "$LIST.n"
  N_FILES="$(cat "$LIST.n" 2>/dev/null)"; rm -f "$LIST" "$LIST.n"
  echo "Dashboard data: $N_FILES files from $WS written to $ESTATE"
}

if [ -n "$BUILDONLY" ]; then build_estate; exit 0; fi
command -v git >/dev/null 2>&1 || { echo "git was not found on PATH."; exit 1; }
if [ ! -f "$REPOS" ]; then
  cat > "$REPOS" <<'T'
# InfraLens repositories - one per line. Optional second word = folder name.
# Lines starting with # are ignored. Save, then run sync again.
# https://bitbucket.example.com/scm/plat/tf-landing-zone.git
# https://bitbucket.example.com/scm/plat/tf-network.git  network
T
  echo "Created $REPOS - add your repository URLs and run sync again."; exit 0
fi
echo "InfraLens sync $(date)" > "$LOG"
echo "InfraLens sync - workspace $WS"
OK=0; FAIL=0; N=0; JSON=""
esc() { printf '%s' "$1" | sed 's/\\/\//g; s/"/'"'"'/g'; }
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"; set -- $line; [ $# -eq 0 ] && continue
  URL="$1"; NAME="${2:-}"
  if [ -z "$NAME" ]; then NAME="$(basename "$URL")"; NAME="${NAME%.git}"; fi
  DIR="$WS/$NAME"; RESULT=ok; MSG=""
  { echo; echo "=== $NAME  $URL"; } >> "$LOG"
  if [ -d "$DIR/.git" ]; then
    echo "  pull   $NAME"
    git -C "$DIR" pull --ff-only >> "$LOG" 2>&1 || { RESULT=failed; MSG="git pull failed - see sync.log"; }
  else
    echo "  clone  $NAME"
    git clone "$URL" "$DIR" >> "$LOG" 2>&1 || { RESULT=failed; MSG="git clone failed - see sync.log"; }
  fi
  COMMIT=""; BRANCH=""; WHEN=""; SUBJECT=""
  if [ -d "$DIR/.git" ]; then
    COMMIT="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null)"
    BRANCH="$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    WHEN="$(git -C "$DIR" log -1 --format=%ci 2>/dev/null)"
    SUBJECT="$(esc "$(git -C "$DIR" log -1 --format=%s 2>/dev/null)")"
  fi
  if [ "$RESULT" = ok ]; then OK=$((OK+1)); else FAIL=$((FAIL+1)); fi
  N=$((N+1))
  echo "         $RESULT  $BRANCH $COMMIT  $MSG"
  [ -n "$JSON" ] && JSON="$JSON,"
  JSON="$JSON{\"name\":\"$NAME\",\"url\":\"$URL\",\"folder\":\"$NAME\",\"result\":\"$RESULT\",\"message\":\"$MSG\",\"branch\":\"$BRANCH\",\"commit\":\"$COMMIT\",\"commit_date\":\"$WHEN\",\"subject\":\"$SUBJECT\"}"
done < "$REPOS"
printf '{"tool":"sync.sh","synced_at":"%s","workspace":"%s","ok":%d,"failed":%d,"repos":[%s]}\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$WS" "$OK" "$FAIL" "$JSON" > "$STATUS"
echo; echo "Done: $OK ok, $FAIL failed ($N listed). Details in $LOG"
build_estate
echo "Open index.html (opening now) - the estate loads by itself. Press F5 after the next sync."
if [ -z "$NOOPEN" ]; then
  case "$(uname -s)" in Darwin) open "$HERE/index.html" ;; MINGW*|MSYS*|CYGWIN*) start "" "$HERE/index.html" ;; *) xdg-open "$HERE/index.html" 2>/dev/null ;; esac
fi
