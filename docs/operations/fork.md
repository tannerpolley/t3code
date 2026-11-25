# Working on the tannerpolley/t3code fork

The fork is upstream `pingdotgg/main` plus a short keep list. It was rebuilt from upstream on 2026-11-25 (#690); the previous fork is tagged `archive/fork-main-2026-11-25`. Prefer upstream behavior everywhere else. When upstream ships something that covers a keep-list item, drop the fork code.

## Keep list

- Named, collapsible sidebar sections, and threads that stay where they are placed.
- Inline math on the text line.
- Codex Default speed (`codexDefaultSpeed`).
- Automatic redemption of expiring credits (`autoUseExpiringResetCredits`).
- The Linux AppImage build and staged install (`apps/desktop/src/updates/ForkStagedUpdates.ts`).
- The GitHub issue pipeline Workflow ([docs/user/workflows.md](../user/workflows.md#run-the-forks-github-issue-pipeline)).

Mobile is out of scope for fork features.

## Branches and checks

- `main` is the only long-lived branch. Work on short-lived branches from `origin/main`; use a worktree next to the checkout only for parallel work.
- Each branch passes `vp run check:changed` locally before review. It only runs tests near changed files.
- Group ready branches into one batch branch, re-run `vp run check:changed` on the combined head, and open one PR. GitHub CI then runs the full suites once for the whole group. CI has caught regressions in suites that `check:changed` never selected.
- Merge only after CI is green, at the head CI checked.
- CI runs on GitHub-hosted `ubuntu-24.04` runners, which are free for this public repository. In the repository's Actions settings, every workflow except `ci.yml` is disabled. Keep it that way: the others release, deploy or comment for upstream.

## Building and installing

`~/.local/bin/t3-update` (the dock icon's **Build & install update**) and `~/.local/bin/t3-build` (the same steps, for agents) build the AppImage from local `main`. They stage it in `~/.local/opt/t3-code/pending/` and tag `release/vX.Y.Z`. The launcher `~/.local/bin/t3-code` installs a staged build on the next start. These scripts live outside Git.

Restarting T3 stops every running agent turn, so ask before doing it.

## Upstream syncs

Merge `pingdotgg/main` on a short-lived `sync/upstream-<date>` branch as a real merge; don't rebase or squash it. Upstream's version wins by default. Measure conflicts first with `git merge-tree --write-tree --name-only --no-messages main pingdotgg/main`.

## One-time cutover from the old fork

The installed app's database comes from the old fork. Before the first build from this `main` opens it, run the conversion in [scripts/fork-sync/README.md](../../scripts/fork-sync/README.md). Until it has run, both build scripts refuse to build.
