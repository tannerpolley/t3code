# Working on the tannerpolley/t3code fork

This is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). It follows
everything in [AGENTS.md](../../AGENTS.md). This page adds what is different about the fork.
Only Codex and Claude matter here; mobile is out of scope.

## Where work is tracked

The fork lives on GitHub at `https://github.com/tannerpolley/t3code`: code, issues and pull
requests. `origin` points there (the older remote `github` is the same URL). Use `gh` and T3's
issue tools. Issue #1 is the roadmap and maintenance tracker. Every task starts from an issue:
the orchestrator creates one before delegating, and links each worker thread to it
(`link_issue`), so the Issues pane shows it In progress. Close an issue when its fix lands on
`main`.

This section owns the hosting rules. Scheduled task prompts and the owner's skills point here
instead of naming a host, because the 2026-11-10 move missed copies in both (#382). When the
host changes, update this section, then search every project's scheduled task prompts, the
`skills` repository and each repository's docs and scripts for the old host.

From 2026-11-02 to 2026-11-10 the owner's repositories lived on a Forgejo server on this desktop
(`https://tnnrpolley21-ms-7c95.taila72856.ts.net:3000`, system service `forgejo`, data in
`/srv/forgejo`). The owner moved everything back with `switch-to-github`
(`~/.local/bin/forgejo-github-sync --switch`). Forgejo is now a read-only archive: every
repository there is archived, the `forgejo-github-sync` and `forgejo-merge-repair` user timers
are disabled, and the nightly `forgejo-backup` timer still copies it to
`chromebox:backups/forgejo`. Never push, open pull requests or write issues there.

Forgejo pull requests were copied to GitHub as closed issues titled "Pull request: …", so most
numbers match. Forgejo issues #289 to #320 are GitHub #288 to #305; their GitHub bodies end with
"Was Forgejo issue #N". `~/.local/state/forgejo-github-sync/<repo>.json` holds the full map for
every repository.

The upstream remote is named `pingdotgg`, not `upstream`: T3 keys a project on a remote named
`upstream` before `origin`, which would key the project on pingdotgg's repository instead of the
fork's.

## Forgejo issue host

The fork's issue features (Issues pane, inbox, roadmap, managed `delegate_task(issue=…)`,
`t3_issue_post`, and `propose_issue_change`) support Forgejo. A host is Forgejo when an `fj`
login key matches it, including the port; GitLab hosts come from `glab auth status --all`,
and unclaimed hosts use GitHub. Logins are read at server
start, so restart T3 after adding one. Store the Forgejo token with `git credential approve` in
the git libsecret helper; `fj` does not install a git credential helper.

Forgejo has no sub-issues: T3 writes `Part of #N <!-- t3:parent=N -->` in the child body,
within the same repository. Blockers use Forgejo issue dependencies; Forgejo refuses to close
an issue with open dependencies (HTTP 412). A fast-forward push of `main` marks a pull request
merged only if its branch still exists when Forgejo checks, so land through Forgejo's merge
instead; on manual detection Forgejo also does not close the issues its body names.
T3 closes them, with a comment, once it sees a pull request linked to a thread merge; for an
unlinked pull request, put `Closes #N` in a pushed commit message or close the issue explicitly.

T3's Forgejo host reads no Projects, and Forgejo sends no ETags, so lists are plain re-reads.
The `state_reason` “not planned” is represented by a close and a comment.

## GitLab issue host

Authenticate with `glab auth login`, then restart T3 to discover self-managed hosts (including
ports). GitLab.com is recognized before login. Group and subgroup project paths are supported.
Sub-issues use the same body markers as Forgejo. Blocking links depend on the project tier and
are unsupported; GitLab has no live issue inbox polling in T3. Labels and milestones work.
After a linked merge request merges, T3 uses GitLab's closing-reference resolution and closes
any named issues still open, including cross-project references.

## git-bug issue host (prototype)

A repository opts in with `git config t3.issues git-bug` in any of its checkouts (the setting is
shared by linked worktrees). Its projects then read and write issues stored in the repository by
[git-bug](https://github.com/git-bug/git-bug) (v0.11.0 tested) under the issue host `git-bug`,
while pull requests stay on the remote's host. Install `git-bug` on the server's PATH and create
or adopt an identity in the repository (`git bug user new`) first. Restart T3 after opting in: as
with Forgejo logins, the git-bug host is added at server start.

T3 runs every git-bug command for a repository in one in-process queue, because git-bug fails
rather than waits when another command holds its repository lock; the user's own `git bug`
commands can still collide with T3's. Issue numbers are git-bug's 7-hex-digit id read as a
number. Labels work; milestones, sub-issues, blockers, assignees, closing from merged pull
requests and inbox notifications do not.

Issues travel as `refs/bugs/*` and `refs/identities/*`. Forgejo accepts them; push with
`git push origin 'refs/bugs/*:refs/bugs/*' 'refs/identities/*:refs/identities/*'`. `git bug
push` and `git bug pull` do not use git's credential helper, so they fail against an HTTPS
remote that needs the Forgejo token. A plain fetch of the same refspecs works when only one side
changed an issue; git-bug then needs its cache rebuilt (`rm -r .git/git-bug/cache`).

## Branches and worktrees

- `main` is the only long-lived branch, and GitHub `main` mirrors local `main`.
- **Each task:**
  - Has a GitHub issue, and gets a short-lived branch, cut from `main`, in a worktree under the project's `.worktrees/` folder.
  - Lands through a pull request: push the branch to `origin`, open a pull request (`gh pr create`) whose body says `Closes #<issue>`, and link it to the worker's thread and the orchestrator's (`link_pull_request`). Review happens on that branch.
  - After review, merge with `gh pr merge <n> --rebase --delete-branch` so `main` stays linear, then `git fetch` and `git merge --ff-only origin/main` locally. Run it from the main checkout: from a worktree it merges but then fails to switch to `main`, which is harmless. Close the issue if it is still open.
  - Then delete the local branch and its worktree. A post-merge hook deletes merged local branches that aren't checked out.
- **Upstream syncs** follow the same path: one issue per sync, and a pull request for the sync branch.
- **Releases** are tags on `main`: `release/vX.Y.Z`.
- **Superseded, unmerged work** becomes an `archive/<name>` tag, not a kept branch.
- **Fixes meant for upstream** go on `upstream-fix/<name>` branches cut from `pingdotgg/main` and pushed to `github`, where pull requests to upstream come from. Keep each one until its upstream pull request closes. Every public post needs the owner's approval.

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
- GitHub Actions are off on the GitHub copy: every workflow is disabled. Upstream's build and test workflows need its paid Blacksmith runners and would wait in the queue forever, and the rest serve upstream's own repository. A workflow that a sync adds starts out enabled: turn it off with `gh workflow disable -R tannerpolley/t3code <name>`.

## Dev preview

The owner reviews UI changes live before a build, on a dev instance with mock data. It is off by default (owner, 2026-10-15): start it only to look at something, then stop it as soon as you are done. Ask the owner before starting it for their own review.

- **What it is:**
  - It runs from the detached worktree `.worktrees/fork-sandbox` as the user unit `t3-dev`.
  - Web prefers `http://localhost:6593` and the server 14633 (`T3CODE_PORT_OFFSET=860`). If a port is taken, the dev runner moves both; the `[dev-runner]` line in `journalctl --user -u t3-dev` shows the real ones.
  - It uses 4–5 GB of memory, most of it the web dev server, and grows with each branch switch.
- **Mock data:** [scripts/fork-dev](../../scripts/fork-dev/README.md) builds it.
  - It creates `~/Workspaces/Sandbox/Workspaces-Dev`: made-up repositories, every thread state and role, and sections.
  - It also maintains real showcase issues in the private `tannerpolley/t3code-sandbox`.
  - Never seed the owner's real projects.
- **Starting and stopping:**
  - `scripts/fork-dev/seed.sh start` starts it; `systemctl --user stop t3-dev` stops it.
  - `scripts/fork-dev/seed.sh` for a full rebuild.
  - The owner's t3code project has two actions, **Open dev preview** and **Close dev preview**, which run `scripts/fork-dev/preview.sh open|close`. Opening resets the sandbox to `main`, replacing any branch an agent was previewing.
- **Previewing branches:** `git -C .worktrees/fork-sandbox checkout --detach main`, then `git -C .worktrees/fork-sandbox merge --no-edit <branch>…`. It reloads on its own.
- **Signing in:** the in-app browser stays signed in through the fixed `T3CODE_DEV_AUTH_TOKEN` in the main checkout's `.env`; never print it. For the owner's own browser, mint a link with `node apps/server/src/bin.ts pair --ttl 2h --base-dir <sandbox>/.t3`.
- **GitHub:** only `scripts/fork-dev/github.py` writes on purpose, and only to the sandbox repository. One exception: open owner decisions in the dev data make the dev instance add the `decision-needed` label, and choosing one posts a comment, on the sandbox repository. Remove test decisions after previewing.

## Building and installing

The dock icon's **Build & install update** action runs `~/.local/bin/t3-update`. It:

1. pushes `main` if `origin` is behind;
2. picks the next patch version after the newest `release/v*` tag (`v2.12.10` → `v2.12.11`) when `main` has moved since that tag; otherwise it offers the existing build;
3. builds in `.worktrees/release-build`: setup, a migration check on a copy of the owner's database, then the AppImage (`T3CODE_DESKTOP_VERSION=<apps/desktop version>-vX.Y.Z`, such as `0.1.0-v2.12.19`);
4. stages the AppImage in `~/.local/opt/t3-code/pending/`, replacing any older staged build;
5. tags `release/vX.Y.Z` and pushes the tag;
6. offers to restart T3.

An agent can run the same steps without the dialogs.

The launcher `~/.local/bin/t3-code` installs a staged build the next time T3 opens:

- It waits up to 20 s for a quitting T3 to release the database.
- It keeps no backup and deletes every older AppImage.
- After installing, it waits for the old T3 to exit and starts the new one in its own systemd unit. A T3 started while the quitting one still holds its single-instance lock quits silently, and Electron's relaunch also hands over the old AppImage's environment. `~/.local/opt/t3-code/launcher.log` records each relaunch.

Restarting T3 stops every running agent turn, so ask before doing it.

When a newer fork build is staged, the in-app update pill offers to install it.
After confirmation, T3 quits and reopens through the launcher to install the build.
It checks for staged builds shortly after startup and every four minutes while running.

## Upstream syncs

- A scheduled task merges the newest upstream nightly tag (on `pingdotgg/main`) daily at 12:00. It uses a short-lived `sync/upstream-<date>` branch that is merged into `main` and deleted. `git rerere` replays repeated conflict resolutions.
- Upstream's version wins by default. Drop fork code once upstream covers the same thing.
- Keep fork code modular so syncs conflict less (issue #24):
  - fork logic lives in fork-owned files, joined to upstream files by small hook points;
  - fork migrations use their own ledger (`ForkMigrations.ts`), and fork RPCs their own group (`ForkWsRpc.ts`).
- Measure conflicts before a sync with `git merge-tree --write-tree --name-only --no-messages main pingdotgg/main`.
- Conflict resolution can drop fork code without a conflict marker or a failing test: the 2026-10-20 sync lost 23 fork behaviors that its review missed. Before merging a sync into `main`, run `scripts/fork-sync/lost-fork-code.py main <upstream commit merged> <sync branch>`. It lists fork-added lines the merge no longer has and fork files nothing imports any more. Judge every flagged hunk: restyled (keep), replaced by upstream's own version (drop the fork code, citing upstream's), or dropped (restore it). The sync review checks those judgments.

## Slow request evidence

The standalone watcher saves requests over 10 seconds (excluding subscription streams) to
`~/.t3/userdata/logs/slow-requests.ndjson`. Each JSON line has the request end time in UTC,
name, duration in milliseconds, slowest descendant steps and their lock waits, top queries
by lock wait, and the machine's 1-, 5-, and 15-minute load averages at collection time.
The repository orchestrator's daily review groups recurring causes and turns them into issues;
one-off machine-load spikes are noted without filing an issue.

Install from the checkout containing the watcher (repeat the two `install` commands when updating):

```sh
install -Dm755 scripts/fork-dev/slow-requests.py ~/.local/lib/t3-code/slow-requests.py
install -Dm644 scripts/fork-dev/t3-slow-requests.service ~/.config/systemd/user/t3-slow-requests.service
systemctl --user daemon-reload
systemctl --user enable --now t3-slow-requests.service
```

Read the latest records with `tail -n 20 ~/.t3/userdata/logs/slow-requests.ndjson`;
pipe one line through `python3 -m json.tool` for a readable breakdown. Check the watcher with
`systemctl --user status t3-slow-requests` or `journalctl --user -u t3-slow-requests`.
Disable it with `systemctl --user disable --now t3-slow-requests`.

The log rotates daily or at 20 MiB into timestamped `slow-requests.ndjson.*` files; archives older
than 14 days are removed hourly. The watcher retains at most 15 minutes or 100,000 spans,
so older descendants can be absent from very long requests. It starts at the beginning of
the active trace file and follows rotations. For an offline replay of the available ten
rotations plus the active file, without writing to the normal output log:

```sh
python3 scripts/fork-dev/slow-requests.py --once \
  --trace ~/.t3/userdata/logs/server.trace.ndjson --out /tmp/slow-requests.ndjson
```

Replays append records, and their load averages describe the replay machine at replay time.
