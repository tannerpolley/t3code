#!/usr/bin/env bash
# Rebuild the mock workspace and the fork-sandbox dev database, then leave t3-dev running.
#   seed.sh        full rebuild: repos, fresh database, all rows
#   seed.sh live   only re-apply live work (runs, background tasks, approvals) after a restart
#   seed.sh start  start t3-dev on the existing database (after a reboot or move), then live
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$HOME/Workspaces-Dev
SANDBOX=$HOME/Workspaces/Applications/t3code/.worktrees/fork-sandbox
USERDATA=$SANDBOX/.t3/userdata

# The usual t3-dev unit, minus the dev runner's own "server" project bootstrapped from its cwd.
# Offset 860 prefers web 6593 and server 14633 wherever the worktree lives; the dev runner moves
# both if a port is taken.
start_dev() {
  systemctl --user reset-failed t3-dev 2>/dev/null || true
  local since
  since=$(date +%s)
  systemd-run --user --unit=t3-dev --description="T3 Code dev instance (fork-sandbox)" \
    --property=Restart=on-failure --property=RestartSec=3 --working-directory="$SANDBOX" \
    --setenv=PATH="$SANDBOX/node_modules/.bin:$PATH" --setenv=T3CODE_BUNDLED_DEV=1 \
    --setenv=T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=0 \
    --setenv=T3CODE_PORT_OFFSET=860 \
    --setenv=VITE_APP_STAGE_LABEL=Alpha \
    node scripts/dev-runner.ts dev
  # Startup recovery is the last step before rows can be written safely.
  for _ in $(seq 240); do
    journalctl --user -u t3-dev --since "@$since" -o cat 2>/dev/null |
      grep "V2 orchestration recovery completed" >/dev/null && return 0 # not -q: pipefail
    sleep 1
  done
  echo "t3-dev did not finish starting; see journalctl --user -u t3-dev" >&2
  return 1
}

stop_dev() { systemctl --user stop t3-dev 2>/dev/null || true; }

# Mock commits ignore the owner's global Git hooks and signing.
g() { GIT_CONFIG_GLOBAL=/dev/null git -C "$repo" -c user.name="T3 Dev Mock" \
  -c user.email="mock@t3-dev-mock.invalid" "$@"; }
tick=0
commit() { # file text message
  mkdir -p "$(dirname "$repo/$1")"
  printf '%s\n' "$2" >>"$repo/$1"
  tick=$((tick + 1))
  local date="2026-09-$(printf %02d $((tick % 28 + 1)))T10:00:00Z"
  g add "$1"
  GIT_AUTHOR_DATE=$date GIT_COMMITTER_DATE=$date g commit -q -m "$3"
}

make_repo() { # relative path, then the worktree branches it keeps
  repo=$ROOT/$1
  local name
  name=$(basename "$1")
  shift
  GIT_CONFIG_GLOBAL=/dev/null git init -q -b main "$repo"
  commit README.md "# $name" "Initial commit"
  commit README.md "Mock project for reviewing T3 Code UI changes." "Describe the project"
  commit CHANGELOG.md "## 1.1.0" "Start a changelog"
  g branch release/1.2
  g branch fix/login-timeout
  commit src/main.txt "entry point for $name" "Add the entry point"
  g branch feature/sidebar-gradient
  g branch experiment/fast-solver
  commit CHANGELOG.md "## 1.1.1" "Note the 1.1.1 fixes"
  for branch in release/1.2 fix/login-timeout feature/sidebar-gradient experiment/fast-solver; do
    g checkout -q "$branch"
    commit "notes/${branch//\//-}.md" "Work on $branch" "Work in progress on $branch"
  done
  g checkout -q main
  # Fake origin: gives the project a repository identity; no branch tracks it, so nothing fetches.
  g remote add origin "https://github.com/t3-dev-mock/$name.git"
  g update-ref refs/remotes/origin/main main
  g symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
  # Same layout and ignore rules T3 writes for project-local worktrees.
  printf '.worktrees/\n' >>"$repo/.git/info/exclude"
  for branch in "$@"; do
    g show-ref --verify --quiet "refs/heads/$branch" || g branch "$branch" main
    g worktree add -q ".worktrees/${branch//\//-}" "$branch"
    # Uncommitted work keeps storage cleanup from removing the worktree.
    printf 'In progress on %s\n' "$branch" >>"$repo/.worktrees/${branch//\//-}/README.md"
  done
  if [ $# -gt 0 ]; then printf '/*\n' >"$repo/.worktrees/.ignore"; fi
}

build_workspace() {
  local dir
  for dir in Apps/aurora-web Apps/borealis-cli Research/cascade-sim Research/delta-notes \
    Scratch/echo-playground; do
    rm -rf "${ROOT:?}/$dir"
  done
  make_repo Apps/aurora-web feature/sidebar-gradient fix/login-timeout chore/vite-7 \
    refactor/theme-layers fix/e2e-flake experiment/canvas
  make_repo Apps/borealis-cli feature/json-status refactor/toml chore/stale-branches
  make_repo Research/cascade-sim experiment/fast-solver experiment/numba-kernel
  make_repo Scratch/echo-playground experiment/pattern-matching ci/matrix docs/badges
  mkdir -p "$ROOT/Research/delta-notes"
  printf '# Turbulence closures\n\n- k-epsilon vs k-omega SST\n' >"$ROOT/Research/delta-notes/closures.md"
  printf '# Weekly log\n\n- Week 41: mock entries only\n' >"$ROOT/Research/delta-notes/weekly-log.md"
}

# The owner's GitHub test repository, for the Issues pane. Read-only: clone once, then fetch.
sync_github_sandbox() {
  local repo=$ROOT/GitHub/t3code-sandbox
  if [ -d "$repo/.git" ]; then
    git -C "$repo" fetch --quiet origin
    git -C "$repo" merge --quiet --ff-only origin/main 2>/dev/null || true # main picks up merged PRs
  else
    mkdir -p "$ROOT/GitHub"
    gh repo clone tannerpolley/t3code-sandbox "$repo" -- --quiet
  fi
  # The #15 issue worker's worktree, on the real PR #24 branch; local only, never pushed.
  local tree=$repo/.worktrees/fix-absolute-zero
  if [ ! -d "$tree" ]; then
    grep -qx '.worktrees/' "$repo/.git/info/exclude" || printf '.worktrees/\n' >>"$repo/.git/info/exclude"
    GIT_CONFIG_GLOBAL=/dev/null git -C "$repo" worktree add -q -B fix/absolute-zero "$tree" origin/fix/absolute-zero
    printf 'In progress on fix/absolute-zero\n' >>"$tree/README.md"
  fi
  local branch
  for branch in t3/issue-6-k-to-c t3/issue-7-f-to-k; do
    tree=$repo/.worktrees/${branch//\//-}
    if [ ! -d "$tree" ]; then
      GIT_CONFIG_GLOBAL=/dev/null git -C "$repo" worktree add -q -B "$branch" "$tree" main
      printf 'In progress on %s\n' "$branch" >>"$tree/README.md"
    fi
  done
}

if [ "${1:-}" = live ]; then
  python3 "$HERE/seed.py" live
  exit 0
fi
if [ "${1:-}" = start ]; then
  start_dev
  python3 "$HERE/seed.py" live
  exit 0
fi

stop_dev
# Before the fresh database starts watching the repository; see github.py.
python3 "$HERE/github.py" >/dev/null
build_workspace
sync_github_sandbox
# Disposable copies: a fresh database and a new environment ID, no backup.
rm -f "$USERDATA"/statev2.sqlite "$USERDATA"/statev2.sqlite-* "$USERDATA/environment-id"
start_dev # migrations create the empty database
stop_dev
python3 "$HERE/seed.py" base
start_dev
python3 "$HERE/seed.py" live
port=$(journalctl --user -u t3-dev -o cat --no-pager | grep -o 'webPort=[0-9]*' | tail -n 1)
echo "t3-dev is running on mock data: http://localhost:${port#webPort=}"
