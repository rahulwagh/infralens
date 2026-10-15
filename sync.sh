#!/usr/bin/env bash
# InfraLens sync - clone or pull every repository listed in repos.txt.
# Twin of sync.cmd for Git Bash / macOS / Linux. Same workspace layout, same
# sync-status.json, so the dashboard shows the result either way.
#
#   ./sync.sh [workspace] [--no-open]      default workspace: ~/infralens-workspace
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WS=""; NOOPEN=""
for a in "$@"; do if [ "$a" = "--no-open" ]; then NOOPEN=1; else WS="$a"; fi; done
WS="${WS:-$HOME/infralens-workspace}"
mkdir -p "$WS"
REPOS="$WS/repos.txt"; STATUS="$WS/sync-status.json"; LOG="$WS/sync.log"
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
echo "Now open the workspace folder in InfraLens and click Re-scan."
if [ -z "$NOOPEN" ]; then
  case "$(uname -s)" in Darwin) open "$HERE/index.html" ;; MINGW*|MSYS*|CYGWIN*) start "" "$HERE/index.html" ;; *) xdg-open "$HERE/index.html" 2>/dev/null ;; esac
fi
