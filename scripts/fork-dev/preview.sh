#!/usr/bin/env bash
# The owner's project actions for the dev preview of `main`, before a build is installed:
#   preview.sh open   put the fork-sandbox worktree on main and start t3-dev
#   preview.sh close  stop t3-dev
# Fixed paths, so the action behaves the same from any thread's worktree.
set -euo pipefail

REPO=$HOME/Workspaces/Applications/t3code
SANDBOX=$REPO/.worktrees/fork-sandbox

case "${1:-}" in
open)
  systemctl --user stop t3-dev 2>/dev/null || true
  before=$(git -C "$SANDBOX" rev-parse HEAD)
  git -C "$SANDBOX" checkout -q --detach main
  # Reinstall only when dependencies changed; it takes a minute or more.
  if ! git -C "$SANDBOX" diff --quiet "$before" HEAD -- pnpm-lock.yaml; then
    echo "Dependencies changed; installing…"
    (cd "$SANDBOX" && PATH="$REPO/node_modules/.bin:$PATH" CI=true T3CODE_PROJECT_ROOT="$REPO" \
      nice -n 10 node scripts/setup-worktree.ts)
  fi
  echo "Starting the dev preview of main: $(git -C "$SANDBOX" log -1 --format='%h %s')"
  "$REPO/scripts/fork-dev/seed.sh" start
  port=$(journalctl --user -u t3-dev -o cat --no-pager | grep -o 'webPort=[0-9]*' | tail -n 1)
  echo "Ready at http://localhost:${port#webPort=} (reload the Browser panel if it opened first)."
  ;;
close)
  systemctl --user stop t3-dev 2>/dev/null || true
  systemctl --user reset-failed t3-dev 2>/dev/null || true
  echo "Dev preview stopped."
  ;;
*)
  echo "usage: preview.sh open|close" >&2
  exit 2
  ;;
esac
