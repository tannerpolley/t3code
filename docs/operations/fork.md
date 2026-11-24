# Working on the tannerpolley/t3code fork

This is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). It follows
everything in [AGENTS.md](../../AGENTS.md). This page adds what is different about the fork.
Only Codex and Claude matter here; mobile is out of scope.

## Where work is tracked

The fork lives on GitHub at `https://github.com/tannerpolley/t3code`: code, issues and pull
requests. `origin` points there (the older remote `github` is the same URL). Use `gh` and T3's
issue tools. Issue #1 is the roadmap and maintenance tracker. Every task starts from an issue:
the orchestrator creates one before delegating, and each worker thread is linked to it, so the
roadmap shows it In progress. Starting or delegating work on the issue links the worker by
itself; link any other thread with `link_issue` and the issue URL. Close an issue when its fix
lands on `main`.

This section owns the hosting rules. Scheduled task prompts and the owner's skills point here
instead of naming a host, because the 2026-11-10 move missed copies in both (#382). When the
host changes, update this section, then search every project's scheduled task prompts, the
`skills` repository and each repository's docs and scripts for the old host.

Forgejo is a read-only archive of the 2026-11-02 to 2026-11-10 period; never write to it.

The upstream remote is named `pingdotgg`, not `upstream`: T3 keys a project on a remote named
`upstream` before `origin`, which would key the project on pingdotgg's repository instead of the
fork's.

## Issue host

GitHub is the only issue host the fork's own issue work uses. Upstream's Issues service owns issue
content: its `/issues` page, its detail panel and its agent tools (`list_issues`, `read_issue`,
`comment_on_issue`, `link_issue`, `unlink_issue`, `list_thread_issues`, and `create_issue` and
`set_issue_state`, which repository-managed threads and every thread below them don't see because
`propose_issue_change` is their gated path). Upstream's other trackers come along unchanged.

The fork adds the work on top: the roadmap at `/roadmap` and in the per-repository Issues panel
beside a thread, with the stages Done / Ready for review / In progress / Queued / Backlog
(`packages/shared/src/issueStage.ts` owns the rule and its names), and a work section inside
upstream's issue panel. Queued and milestone issues share one admission path: the repository's
periodic reconcile starts a managed worker for each unblocked queued issue, then for milestone
issues, and the worker limit admits queued issues' workers first. The roadmap uses conditional GitHub REST issue pages for its unfiltered
listing, avoiding the search and viewer GraphQL queries. Issue details and the issues, edits, state
changes and comments that `propose_issue_change` and status comments write go through upstream's
service. A fork-owned GitHub extension (`apps/server/src/issues/IssueGitHubExtension.ts`) supplies relationships,
milestones, Project fields, marked-comment updates, and the identity and activity needed for
retries and the inbox. `t3_issue_post` uses the extension because it can target repositories
outside the configured projects and returns the new issue or comment URL.
Thread links live only in upstream's `thread.issues[]`: a managed claim
(`linkedIssue`) writes its link in the same event, and a claim still counts as live work after
its link is removed. At each start, a backfill moves the retired `issue_thread_links` rows and
older GitHub claims onto `thread.issues[]`, until the table is empty and every GitHub claim is
linked; after that it finds nothing to do. Rows and claims on other hosts, such as the archived
Forgejo, are not linked: their rows are dropped and their claims stay claims.

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
- The owner's launcher sets `T3CODE_PR_WATCH_NO_CHECKS_REPOSITORIES=github.com/tannerpolley/t3code` for the desktop's server. This comma-separated list of `host/owner/repo` keys skips the initial wait for checks on those repositories. Checks that do report, such as review-bot checks, still count. Set the same variable on a standalone server that should use this policy.
- The owner's launcher sets `T3CODE_ISSUE_DRAFT_PR_REPOSITORIES=github.com/tannerpolley/t3code`. This server setting is empty by default and accepts a comma-separated list of `host/owner/repo` keys. It authorizes new T3-generated issue worker briefs, including milestone starts, to publish the issue branch and a ready-for-review PR after checks and a fresh reviewer pass, then merge that PR themselves and report the merge SHA. Managed workers in these repositories get no automatic PR watch; the orchestrator builds, installs, and closes out after the worker's completion wake. Other repositories keep the orchestrator merge and the automatic watch. Set the same variable before starting a standalone server that should grant this authority.

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

The launcher `~/.local/bin/t3-code` handles staged installs on ordinary launches and in-app update restarts.
For `t3code://` links, it passes the URL straight to the installed AppImage, bypassing the install lock and database wait.

- It waits up to 20 s for a quitting T3 to release the database.
- It keeps no backup and deletes every older AppImage.
- After installing, it waits for the old T3 to exit and starts the new one in its own systemd unit. A T3 started while the quitting one still holds its single-instance lock quits silently, and Electron's relaunch also hands over the old AppImage's environment. `~/.local/opt/t3-code/launcher.log` records each relaunch.

Restarting T3 stops every running agent turn, so ask before doing it.

When a newer fork build is staged, the in-app update pill offers to install it.
After confirmation, T3 quits and reopens through the launcher to install the build.
It checks for staged builds shortly after startup and every four hours while running.

The owner's launcher passes these settings on both startup paths:

```sh
export T3CODE_DESKTOP_LAUNCHER_PATH="$HOME/.local/bin/t3-code"
export T3CODE_STAGED_UPDATE_DIRECTORY="$HOME/.local/opt/t3-code/pending"
export T3CODE_STAGED_UPDATE_VERSION_PATTERN='^(\d+(?:\.\d+)*)-v(2\.\d+(?:\.\d+)*)$'
```

The pattern matches the full app version and the version in `T3-Code-<version>-x86_64.AppImage`.
Its first two captures are the dotted numeric base and staged build versions. Setting either
staged-update variable selects local staging. If the launcher configuration is incomplete or
invalid, the desktop log identifies the variable, its value, and why staging was disabled.

## Upstream syncs

- Syncs are manual; no daily scheduled task is configured. The last completed sync was 2026-11-17 (`v0.1.11-nightly.20261117.4851`). Merge the selected upstream nightly tag from `pingdotgg/main` on a short-lived `sync/upstream-<date>` branch, preserving the upstream parent in a real merge. Merge the sync PR without rebasing or squashing, then delete the branch. `git rerere` replays repeated conflict resolutions.
- Upstream's version wins by default. Drop fork code once upstream covers the same thing.
- Keep fork code modular so syncs conflict less (issue #24):
  - fork logic lives in fork-owned files, joined to upstream files by small hook points;
  - fork migrations use their own ledger (`ForkMigrations.ts`), and fork RPCs their own group (`ForkWsRpc.ts`).
- The fork edits upstream's own issue code in seven files, and a sync that changes Issues will conflict there. Keep these edits:
  - `apps/web/src/components/issue/IssueDetailPanel.tsx`: the slot for the fork's work section.
  - `apps/server/src/mcp/toolkits/issues/tools.ts`: `create_issue` and `set_issue_state` hidden from repository-managed threads.
  - `apps/server/src/issue/IssueService.ts`, `packages/contracts/src/issue.ts`, `packages/source-control-core/src/server/IssueTracker.ts`, and `GitHubIssueTracker.ts` and `gitHubIssueJson.ts` in `packages/source-control-github/src/server/`: a milestone on create, the GitHub ids a create returns, the comment id a comment returns, and the `rejected` error reason. Managed issue writes need these to retry safely.
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
