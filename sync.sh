#!/usr/bin/env bash
# InfraLens sync - same as sync.cmd, for Git Bash / macOS / Linux.
# Everything lives in this folder: repos.txt (the list), repos/<name>/ (clones),
# estate.js (all files of repos/, loaded by index.html), sync-status.json, sync.log.
#   ./sync.sh                 clone or pull every repo, then write estate.js
#   ./sync.sh --build-only    only rewrite estate.js
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPOS="$HERE/repos.txt"; DEST="$HERE/repos"; STATUS="$HERE/sync-status.json"; LOG="$HERE/sync.log"; ESTATE="$HERE/estate.js"
BUILDONLY=""; for a in "$@"; do [ "$a" = "--build-only" ] && BUILDONLY=1; done

# estate.js = { name, generated_at, workspace, files: [{path, text}] } - pure awk.
build_estate() {
  LIST="$(mktemp 2>/dev/null || echo "$HERE/.files.tmp")"
  { for f in repos.txt sync-status.json; do [ -f "$HERE/$f" ] && echo "$f"; done
    [ -d "$DEST" ] && ( cd "$DEST" && find . \( -name .git -o -name node_modules -o -name .terraform \) -prune -o -type f \( -name '*.tf' -o -name '*.tfvars' -o -name '*.json' -o -name '*.yaml' -o -name '*.yml' -o -name '*.hcl' -o -name '*.md' -o -name '*.txt' \) -print | sed 's|^\./|repos/|' | sort ); } > "$LIST"
  awk -v when="$(date '+%Y-%m-%dT%H:%M:%S')" -v here="$HERE" -v list="$LIST" '
    function esc(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); gsub(/\t/, "\\t", s); gsub(/\r/, "\\r", s); gsub(/[\001-\010\013\014\016-\037]/, "", s); return s }
    BEGIN {
      printf "window.__INFRALENS_ESTATE__ = {\"name\":\"infralens\",\"generated_at\":\"%s\",\"workspace\":\"%s\",\"files\":[", when, esc(here "/repos")
      n = 0
      while ((getline p < list) > 0) {
        f = here "/" p; text = ""; first = 1
        while ((getline line < f) > 0) { text = text (first ? "" : "\\n") esc(line); first = 0 }
        close(f)
        out = p; sub(/^repos\//, "", out)
        printf "%s{\"path\":\"%s\",\"text\":\"%s\"}", (n ? "," : ""), esc(out), text
        n++
      }
      print "]};"
      printf "%d", n > "/dev/stderr"
    }' > "$ESTATE" 2> "$LIST.n"
  echo "Dashboard data: $(cat "$LIST.n" 2>/dev/null) files written to estate.js"; rm -f "$LIST" "$LIST.n"
}
if [ -n "$BUILDONLY" ]; then build_estate; exit 0; fi

command -v git >/dev/null 2>&1 || { echo "git was not found on PATH."; exit 1; }
if [ ! -f "$REPOS" ]; then cp "$HERE/repos.example.txt" "$REPOS"; echo "Created repos.txt - add your repository URLs to it and run sync again."; exit 0; fi
mkdir -p "$DEST"
echo "InfraLens sync $(date)" > "$LOG"
echo "InfraLens sync - cloning into $DEST"
OK=0; FAIL=0; N=0; JSON=""
esc() { printf '%s' "$1" | sed 's/\\/\//g; s/"/'"'"'/g'; }
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"; set -- $line; [ $# -eq 0 ] && continue
  URL="$1"; NAME="${2:-}"
  # URLs may carry credentials (https://user:token@host/...). SAFE drops them and
  # is what gets logged, displayed and written to sync-status.json.
  SAFE="$(printf '%s' "$URL" | sed -E 's#^(https?://)[^/@]+@#\1#')"
  CRED="$(printf '%s' "$URL" | sed -nE 's#^https?://([^/@]+)@.*#\1#p')"
  if [ -z "$NAME" ]; then NAME="$(basename "$SAFE")"; NAME="${NAME%.git}"; fi
  DIR="$DEST/$NAME"; RESULT=ok; MSG=""
  { echo; echo "=== $NAME  $SAFE"; } >> "$LOG"
  TMPLOG="$(mktemp 2>/dev/null || echo "$HERE/.git.tmp")"
  if [ -d "$DIR/.git" ]; then
    echo "  pull   $NAME"; git -C "$DIR" pull --ff-only > "$TMPLOG" 2>&1 || { RESULT=failed; MSG="git pull failed - see sync.log"; }
  else
    echo "  clone  $NAME"; git clone "$URL" "$DIR" > "$TMPLOG" 2>&1 || { RESULT=failed; MSG="git clone failed - see sync.log"; }
  fi
  awk -v c="${CRED}@" 'c != "@" { while ((i = index($0, c)) > 0) $0 = substr($0, 1, i - 1) "***@" substr($0, i + length(c)) } 1' "$TMPLOG" >> "$LOG"; rm -f "$TMPLOG"
  COMMIT=""; BRANCH=""; WHEN=""; SUBJECT=""
  if [ -d "$DIR/.git" ]; then
    COMMIT="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null)"; BRANCH="$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    WHEN="$(git -C "$DIR" log -1 --format=%ci 2>/dev/null)"; SUBJECT="$(esc "$(git -C "$DIR" log -1 --format=%s 2>/dev/null)")"
  fi
  if [ "$RESULT" = ok ]; then OK=$((OK+1)); else FAIL=$((FAIL+1)); fi; N=$((N+1))
  echo "         $RESULT  $BRANCH $COMMIT  $MSG"
  [ -n "$JSON" ] && JSON="$JSON,"
  JSON="$JSON{\"name\":\"$NAME\",\"url\":\"$SAFE\",\"folder\":\"$NAME\",\"result\":\"$RESULT\",\"message\":\"$MSG\",\"branch\":\"$BRANCH\",\"commit\":\"$COMMIT\",\"commit_date\":\"$WHEN\",\"subject\":\"$SUBJECT\"}"
done < "$REPOS"
printf '{"tool":"sync.sh","synced_at":"%s","workspace":"%s","ok":%d,"failed":%d,"repos":[%s]}\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$DEST" "$OK" "$FAIL" "$JSON" > "$STATUS"
echo; echo "Done: $OK ok, $FAIL failed ($N listed). Details in sync.log"
build_estate
echo "Now open index.html, or refresh it if it is already open."
