# Working on the tannerpolley/t3code fork

The fork is upstream `pingdotgg/main` plus a short keep list. It was rebuilt from upstream on 2026-11-25 (#690); the previous fork is tagged `archive/fork-main-2026-11-25`. Prefer upstream behavior everywhere else. When upstream ships something that covers a keep-list item, drop the fork code.

## Keep list

- Named, collapsible sidebar sections, and threads that stay where they are placed.
- Inline math on the text line.
- Codex Default speed (`codexDefaultSpeed`).
- Automatic redemption of expiring credits (`autoUseExpiringResetCredits`).
- The Linux AppImage build and staged install (`apps/desktop/src/updates/ForkStagedUpdates.ts`).
- The GitHub issue pipeline Workflow ([docs/user/workflows.md](../user/workflows.md#run-the-forks-github-issue-pipeline)).

Mobile runs the fork through its own Android app; see [Android app](#android-app).

## Branches and checks

- `main` is the only long-lived branch. Work on short-lived branches from `origin/main`; use a worktree next to the checkout only for parallel work.
- Heavy checks run on GitHub, not this shared machine. Workers run only the test files they changed or that sit beside changed files (`vp test run <files>`). For fork work this replaces AGENTS.md's `vp run check:changed` before push.
- Group ready branches into one batch branch and open one PR. GitHub CI runs `check:changed`'s fast checks and the full suites once for the whole group. When CI fails, the failing job's files point to the branch responsible.
- Give a batch with UI changes one live dev-client check, not one per branch.
- Merge only after CI is green, at the head CI checked.
- CI runs on GitHub-hosted `ubuntu-24.04` runners, which are free for this public repository. In the repository's Actions settings, every workflow except `ci.yml` is disabled. Keep it that way: the others release, deploy or comment for upstream.

## Building and installing

`~/.local/bin/t3-update` (the dock icon's **Build & install update**) and `~/.local/bin/t3-build` (the same steps, for agents) build the AppImage from local `main`. They stage it in `~/.local/opt/t3-code/pending/` and tag `release/vX.Y.Z`. The launcher `~/.local/bin/t3-code` installs a staged build on the next start. These scripts live outside Git.

Restarting T3 stops every running agent turn, so ask before doing it.

### Android app

The Play Store app speaks an older protocol than this server, so the owner's Pixel runs a fork APK built on this PC.

- `scripts/fork-android/build-apk.sh [commit]` (default `origin/main`) builds a release APK in `~/Workspaces/Applications/t3code/.worktrees/android-build` and writes `~/.local/opt/t3-code/android/t3code-fork-<sha>.apk`, with `latest.apk` pointing at it. A commit that is already built is skipped. It needs `~/Android/Sdk` and a JDK; Gradle downloads the NDK on the first run.
- `scripts/fork-android/install-apk.sh [apk]` installs it with `adb install -r` on the Pixel (`49191FDAQ001KZ`) over USB, and says so when the phone is not connected.
- The app is `com.tannerpolley.t3code` ("T3 Code Fork"), so it installs beside upstream's `com.t3tools.t3code`. Its versionCode is the commit count, so newer `main` builds install over older ones.
- It is signed with a key made on the first build at `~/.local/share/t3-android/fork-release.p12` (password in `.pass` beside it). Losing that key means uninstalling the app, and its pairings, before the next install.
- Over-the-air updates are off, or upstream's update channel would replace the fork's JavaScript.
- Pair it with the desktop server over Tailscale. Push notifications through T3 Connect do not reach it: the relay sends through upstream's Firebase project, and the fork has neither that project's `google-services.json` nor a package registered in it. Push needs the fork's own Firebase project and its own sender.

## Upstream syncs

Merge `pingdotgg/main` on a short-lived `sync/upstream-<date>` branch as a real merge; don't rebase or squash it. Upstream's version wins by default. Measure conflicts first with `git merge-tree --write-tree --name-only --no-messages main pingdotgg/main`.

## One-time cutover from the old fork

The installed app's database comes from the old fork. Before the first build from this `main` opens it, run the conversion in [scripts/fork-sync/README.md](../../scripts/fork-sync/README.md). Until it has run, both build scripts refuse to build.
