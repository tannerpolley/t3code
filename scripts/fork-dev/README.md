# Mock data for the T3 Code dev instance

Rebuilds `~/Workspaces-Dev` (four Git repos, one plain folder) and the `fork-sandbox` dev database
with mock projects, threads, timelines and sidebar sections, then leaves the `t3-dev` unit
running. Together they cover most sidebar and chat states:

- **Sidebar rows:** Working, Waiting, Done, idle, settled, Approval, Input, Failed, Limited,
  snoozed, Woke, pinned, archived, and plan mode.
- **Background tasks:** a server, a watcher, a Python job and a monitor.
- **Thread families:** one repository orchestrator per project, direct workers, and nested helpers.
- **Pull requests:** open, draft, merged and closed, including 123 PRs on the aurora orchestrator.
- **Roles:** explicit roles keep only the repository coordinator labeled Orchestrator. Direct
  Implementors have separate worktrees; Reviewers, Investigators and Checkers share the main
  checkout. Nested native helpers share their parent's checkout.
- **Questions:** a Claude single-choice question and a Codex multi-select question
  ("Choose the release checks for borealis 1.2").
- **Task list:** the aurora-web orchestrator's Claude task list, shown above the composer.
- **Issues:** real issues and PRs in `tannerpolley/t3code-sandbox` (see below).

## Project layout

Each project has one main-checkout orchestrator above its workers in Projects with the default
activity order. Workers stay nested across checkouts: Implementors, Reviewers, Investigators,
Checkers, then other roles, newest activity first within a role. In **Family style → Lines**,
dashed lines mark checkout changes and solid lines separate families.

- **aurora-web (APPS):** “Coordinate the sidebar gradient redesign”; gradient-header Implementor
  with a nested token investigator, a Reviewer, two main-checkout Investigators and a Checker.
  Historical Implementors retain merged, usage-limited, snoozed and archived examples in separate
  worktrees. One standalone Implementor, “Fix login timeout on slow networks”, keeps Done/unseen,
  the open PR and checkpoint diff available. The orchestrator carries the 123-PR badge and task list.
- **borealis-cli (APPS):** “Coordinate borealis 1.2”; separate worktrees for JSON output, TOML and
  branch cleanup (Approval), a packaging Investigator with a nested wheel Checker, and the
  multi-select release-checks Checker. The one standalone Investigator retains the plugin plan.
- **cascade-sim (RESEARCH → EXPERIMENTS):** “Run the 10k-cell solver benchmark campaign”; two
  Implementors in distinct worktrees, a nested kernel profiler, main-checkout Reviewers,
  Investigators (including the charting question) and the benchmark Checker with background work.
  One standalone settled Investigator retains the long boundary-condition title.
- **delta-notes (OTHER PROJECTS):** “Coordinate turbulence research notes”; a main-folder
  Investigator, plus one standalone settled Investigator for the weekly log. This is a plain
  folder, without Git or worktrees.
- **echo-playground (OTHER PROJECTS):** “Coordinate playground experiments”; a pattern-matching
  Implementor and README Implementor in separate worktrees, plus a main-checkout parser Checker.
  One standalone Implementor retains the failed CI run and closed PR.
- **t3code-sandbox (GitHub sandbox):** “Coordinate t3code-sandbox issues”; the real #6, #7 and #15
  issue Implementors each have their own local worktree, with #15 linked to real PR #24.
  `github.py` and the passive repository orchestration settings are unchanged.

The empty INBOX section stays available for section review. Finished children remain hidden in
Projects unless held by pending work; their states and timelines are retained. `shot.mjs` opens
such examples by route when they have no visible row (including the usage-limited child), keeping
all existing screenshot titles usable.

## Rerun

From the main checkout:

```sh
scripts/fork-dev/seed.sh        # full rebuild: repos, fresh database, all rows
scripts/fork-dev/seed.sh start  # start t3-dev on the existing database (after a reboot), then live
scripts/fork-dev/seed.sh live   # after any t3-dev restart: bring back live work
python3 scripts/fork-dev/github.py  # sandbox issues and PRs; seed.sh runs it
node scripts/fork-dev/shot.mjs  # optional: headless screenshots
node scripts/fork-dev/icon-review.cjs  # optional: every icon in use, as shots/icon-review.html
```

After changing this fixture layout, run **`scripts/fork-dev/seed.sh` with no arguments**;
`start` and `live` do not rebuild thread lineage or worktrees. A full rebuild stops `t3-dev`,
deletes the dev database and `environment-id`, and starts the unit again. Rerun it every few days: thread times are relative to the seed, and after three idle days
the server auto-settles unsettled threads.

Generated output (Claude task files, screenshots) goes to `~/Workspaces-Dev/.t3-dev-fixture/`,
outside the repository.

## Things that are not obvious

- **Restarts cancel live work.** Server startup and shutdown cancel the following:
  - running runs and native subagents;
  - background tasks: the dev server, the `dist/` watcher, and the benchmark job and its monitor;
  - pending approvals.

  A restart, including a dev-watch reload, clears them. Run `seed.sh live` to bring them back.

- **What survives restarts:**
  - pending questions, which are answered by message;
  - the open delegated-task cards, which keep their parents Waiting.
- **Mock content still triggers real actions when you use it.** These all start a real Claude or
  Codex turn, like typing a message in the dev app:
  - answering a pending question;
  - choosing Implement on the plan;
  - choosing "Resume at reset" on the usage-limited thread.

  Nothing runs on its own. No mock row has a provider session, child threads have no node fork,
  and the usage-limit recovery is pre-armed with auto-resume off.

- **Approvals and Stop fail harmlessly.** They need a live provider session, which mock threads
  don't have.
- **Background output files:**
  - Codex task output lives under the dev server's `userdata/logs/background-tasks`.
  - Claude task output lives in `~/Workspaces-Dev/.t3-dev-fixture/tasks/`.

  Opening a task's output or following it in a terminal shows that fake text.

- **Child threads appear in the Projects view only while active.** Running children, children
  with pending work, and children waiting on you are listed under their parent. Finished
  children are hidden in that view.
- **Start command.** `seed.sh` starts `t3-dev` with `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=0`.
  Without it, the dev runner adds a project for its own `apps/server` folder.
- **Settings.** The seed sets `worktreesDirectory: "project-local"` and
  `addProjectBaseDirectory: ~/Workspaces-Dev` in the dev `settings.json`, so worktrees created in
  the UI go to `<repo>/.worktrees` like the seeded ones.
- **Fake remotes, PRs and issues.**
  - Origins are `https://github.com/t3-dev-mock/<repo>.git`. No branch tracks them, so nothing
    fetches.
  - PR state comes from seeded snapshots. GitHub lookups for these repos return 404 and log
    warnings, but the snapshots are kept.
  - The linked issue shows in Thread details. Its body and the Issues page need GitHub, so they
    stay empty.
- **Sandbox issues (`github.py`).** Creates, only when missing, the showcase set in
  `tannerpolley/t3code-sandbox`: parent #13 with sub-issues #14–#16 and #18 (#16 has sub-issue
  #17), blocked-by chains #15←#14, #16←#15, #19←#13 and #3, closed as completed (#14) and not
  planned (#18), PRs #23 (merged, closes #14), #24 (open, closes #15) and #25 (draft, closes
  #16), milestone `02 - Release 1.0`, `priority: high` (#19, #20), and two cross-project inbox
  items (#21, #22: `external`, `from:<project>`, with T3 source markers). Older data: #1–#11
  and PR #12.
  - **Run it before the database is rebuilt** (seed.sh does). The dev server's issue inbox
    labels any issue opened after it started watching as `external` and `priority: high` _on
    GitHub_, even with repository work paused. That happened once on 2026-10-14; `github.py`
    resets the labels it owns.
- **Issues pane.** The Issues page lists every repository the `gh` login owns, so it shows the
  owner's real repositories too, and takes 15–40 s to load. The mock projects' fake remotes
  have no issues; open the sandbox from its project, its orchestrator's Thread details, or
  `/issues?host=github.com&repository=tannerpolley/t3code-sandbox`.
- **Process groups can't be mocked.** The resource monitor samples only the server's own
  process tree, so the spawned-process rows need a real agent command. Running command rows
  (`pnpm` under the gradient header Implementor) and background tasks do show.
- **GitHub sandbox (real data, read-only).** `seed.sh` clones the owner's private test repository
  `tannerpolley/t3code-sandbox` into `GitHub/t3code-sandbox` once, then only fetches.
  - **What the seed reads:** `seed.py` reads the repository's ID and the IDs and titles of the
    issues it links (#6, #7, #15) with `gh api` GET requests. `github.py` runs separately first.
  - **What it seeds:** a repository orchestrator thread, plus issue workers on #6, #7 and #15
    (#15 finished in the local worktree `.worktrees/fix-absolute-zero`, linked to PR #24).
    - #6 has a live run, so it is "working".
    - #7 has a pending question, so it is "waiting on you".
    - Both turn blue in the Issues roadmap view.
  - **Why it stays passive:**
    - **Paused:** `paused = 1` stops admission and the reconcile loop.
    - **No milestones:** an empty milestone list keeps the root out of the 60-second scheduler.
    - **Publishing off:** both publish flags are 0, so no status or closeout comment is ever
      queued.
    - **No minimum override:** `worker_limit` is 1, the database minimum.
  - **What starts real work:** "Resume repository work" or "Work through milestone" in the
    Issues pane would start real agents.
  - **Where the colors show:**
    - **Issues panel, roadmap view:** blocked issues are red and #6 and #7 are blue. Open it from
      the orchestrator's Thread details, Issues, "Browse all issues", with Roadmap view on.
    - **Full Issues page:** always shows milestones. Closed issues are gray there with the Closed
      filter on.
- **Protected worktrees.** Each worktree has an uncommitted change, which keeps storage cleanup
  from removing it.
- **Views.** The Projects view is the `sidebarMode` UI state (`t3code:ui-state:v1`). It is not a
  client setting. `shot.mjs` sets it before taking screenshots.
