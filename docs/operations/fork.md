# Working on the tannerpolley/t3code fork

This is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). It follows
everything in [AGENTS.md](../../AGENTS.md). This page adds what is different about the fork.
Only Codex and Claude matter here; mobile is out of scope.

## Where work is tracked

Plans and bugs live in the fork's GitHub issues. Issue #1 is the roadmap and maintenance tracker.
Close an issue when its fix lands on `main`.

## Branches and worktrees

- `main` is the only long-lived branch, and GitHub `main` mirrors local `main`.
- **Each task:**
  - Gets a short-lived branch, cut from `main`, in a worktree under the project's `.worktrees/` folder.
  - After review, merge it into `main` with a fast-forward or merge commit, then push `main`.
  - Then delete the branch and its worktree. A post-merge hook deletes merged branches that aren't checked out.
- **Releases** are tags on `main`: `release/vX.Y.Z`.
- **Superseded, unmerged work** becomes an `archive/<name>` tag, not a kept branch.
- **Fixes meant for upstream** go on `upstream-fix/<name>` branches cut from `upstream/main`. Keep each one until its upstream pull request closes. Every public post needs the owner's approval.

Set up a worktree you created by hand like this. `vp` is not on `PATH` outside the dev scripts:

```sh
M=~/Workspaces/Applications/t3code
PATH=$M/node_modules/.bin:$PATH CI=true T3CODE_PROJECT_ROOT=$M node scripts/setup-worktree.ts
```

## Checks

- Type check one package: `nice -n 10 ../../node_modules/.bin/tsc-rs --noEmit` inside it. Plain `tsc` can take 20+ minutes.
- Tests: `vp test run <files>`.
  - Run Git tests with `GIT_CONFIG_GLOBAL=/dev/null`, because the owner's global hooks interfere. One failure about binary diff statistics on Git 2.43 comes from the environment, not the code.
  - A branch that adds an MCP tool must also pass `apps/server/src/mcp/toolkits/core.test.ts`, which checks tool labels.
- GitHub Actions are off on the fork: every workflow is disabled. Upstream's build and test workflows need its paid Blacksmith runners and would wait in the queue forever, and the rest serve upstream's own repository. A workflow that a sync adds starts out enabled: turn it off with `gh workflow disable -R tannerpolley/t3code <name>`.

## Dev preview

The owner reviews UI changes live before a build, on a dev instance with mock data. It is off by default (owner, 2026-10-15): start it only to look at something, then stop it as soon as you are done. Ask the owner before starting it for their own review.

- **What it is:**
  - It runs from the detached worktree `.worktrees/fork-sandbox` as the user unit `t3-dev`.
  - Web prefers `http://localhost:6593` and the server 14633 (`T3CODE_PORT_OFFSET=860`). If a port is taken, the dev runner moves both; the `[dev-runner]` line in `journalctl --user -u t3-dev` shows the real ones.
  - It uses 4–5 GB of memory, most of it the web dev server, and grows with each branch switch.
- **Mock data:** [scripts/fork-dev](../../scripts/fork-dev/README.md) builds it.
  - It creates `~/Workspaces-Dev`: made-up repositories, every thread state and role, and sections.
  - It also maintains real showcase issues in the private `tannerpolley/t3code-sandbox`.
  - Never seed the owner's real projects.
- **Starting and stopping:**
  - `scripts/fork-dev/seed.sh start` starts it; `systemctl --user stop t3-dev` stops it.
  - `scripts/fork-dev/seed.sh` for a full rebuild.
- **Previewing branches:** `git -C .worktrees/fork-sandbox checkout --detach main`, then `git -C .worktrees/fork-sandbox merge --no-edit <branch>…`. It reloads on its own.
- **Signing in:** the in-app browser stays signed in through the fixed `T3CODE_DEV_AUTH_TOKEN` in the main checkout's `.env`; never print it. For the owner's own browser, mint a link with `node apps/server/src/bin.ts pair --ttl 2h --base-dir <sandbox>/.t3`.
- **GitHub:** the dev instance never writes to GitHub. Only `scripts/fork-dev/github.py` writes, and only to the sandbox repository.

## Building and installing

The dock icon's **Build & install update** action runs `~/.local/bin/t3-update`. It:

1. pushes `main` if GitHub is behind;
2. picks the next patch version after the newest `release/v*` tag (`v2.12.10` → `v2.12.11`) when `main` has moved since that tag; otherwise it offers the existing build;
3. builds in `.worktrees/release-build`: setup, a migration check on a copy of the owner's database, then the AppImage (`T3CODE_DESKTOP_VERSION=0.0.45-vX.Y.Z`);
4. stages the AppImage in `~/.local/opt/t3-code/pending/`, replacing any older staged build;
5. tags `release/vX.Y.Z` and pushes the tag;
6. offers to restart T3.

An agent can run the same steps without the dialogs.

The launcher `~/.local/bin/t3-code` installs a staged build the next time T3 opens:

- It waits up to 20 s for a quitting T3 to release the database.
- It keeps no backup and deletes every older AppImage.

Restarting T3 stops every running agent turn, so ask before doing it.

When a newer fork build is staged, the in-app update pill offers to install it.
After confirmation, T3 quits and reopens through the launcher to install the build.
It checks for staged builds shortly after startup and every four minutes while running.

## Upstream syncs

- A scheduled task merges `upstream/main` daily at 12:00. It uses a short-lived `sync/upstream-<date>` branch that is merged into `main` and deleted. `git rerere` replays repeated conflict resolutions.
- Upstream's version wins by default. Drop fork code once upstream covers the same thing.
- Keep fork code modular so syncs conflict less (issue #24):
  - fork logic lives in fork-owned files, joined to upstream files by small hook points;
  - fork migrations use their own ledger (`ForkMigrations.ts`), and fork RPCs their own group (`ForkWsRpc.ts`).
- Measure conflicts before a sync with `git merge-tree --write-tree --name-only --no-messages main upstream/main`.
