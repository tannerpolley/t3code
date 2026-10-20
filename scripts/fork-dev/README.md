# Feature examples for the fork's dev preview

The seed rebuilds the mock projects in `~/Workspaces-Dev` and the `fork-sandbox` dev database.
There are eight labeled projects, 56 threads and 88 synthetic processes. Hover a sidebar role
title to read that thread's **Check:** name; every orchestrator's name summarizes its project's
checklist. Expand a thread to see its commands, process groups and nested agents.

## Project checklist

1. **01 · Processes and background work** — expand the C++ Implementor: `ccache`, `c++` and
   `cc1plus` each fold **16 members** into one row. Open a member caret and click a process for
   its command details. Compare the Vite `node`/`esbuild` groups, Rust's **12 `rustc`** members,
   and its nested Checker's **eight pytest xdist workers**. The finished benchmark Checker has
   only processes and background work, with no child agents: a Python job, multiprocessing
   workers, a log writer and a monitor. Check CPU, memory, running marks, elapsed times and
   command output. The Rust thread has processes followed by a dashed separator before agents.
2. **02 · Thread families and separators** — one orchestrator above Implementors, Reviewer,
   Investigator and Checker. Newer Implementors sort first within their role. Helpers stay
   nested below their parent. In **Family style → Lines**, solid lines separate families and
   dashed lines mark checkout changes; the standalone Investigator supplies another family.
3. **03 · Roles and native subagents** — explicit app-owned roles beside native Claude
   `general-purpose`, `Explore`, `code-reviewer` and Codex `worker`, `explorer`, `tester` agents.
   Compare role-column alignment and inspect the generic native agent's label. This fixture
   uses the existing `nativeSubagentRole` mapping from the checkout being seeded, so the
   parallel change that labels generic native agents **Worker** can be checked after merging.
4. **04 · Statuses and attention** — Working, Waiting (a completed parent with an active child),
   Done/unseen, idle/visited, settled, Approval, Input, Failed, Limited, future snooze, expired
   snooze/Woke, pinned and archived. Standalone rows keep finished examples discoverable;
   enable the relevant settled, snoozed or archived filter to see parked threads. Open the
   usage-limit row for its reset card; auto-resume is off.
5. **05 · PR badges and checkpoint diffs** — the orchestrator has **123 PRs**. Dedicated rows
   show open/passing/review-required, draft/failing/conflicting, merged/approved and closed
   snapshots. The login-fix row has a checkpoint Diff with before/after files, a rich answer,
   and a completed inline shell result. All these PRs are mock snapshots.
6. **06 · Questions, plans and task lists** — the Claude orchestrator has completed, running and
   pending tasks above the composer. Open the Claude question for single-choice questions and
   a custom answer, the Codex Checker for multi-select release gates, and the standalone plugin
   plan for plan mode and the proposed-plan card.
7. **07 · Sections and plain folders** — under **Folder sections → Plain folders**, inspect a
   project with no Git metadata and a deliberately long settled thread title. **Feature
   showcases** uses folder icons; the **INBOX** is empty. The GitHub project is deliberately
   unsectioned, supplying the **Other projects** example.
8. **08 · GitHub issues · t3code-sandbox** — the real private repository stays at
   `GitHub/t3code-sandbox`. Its orchestrator is paused with publishing off. Issue Implementors
   #6 (Working), #7 (Input) and #15 (finished, real PR #24) retain their separate worktrees.
   Open the Issues roadmap for blue working/input rows and red dependency blocks; inspect
   Thread details for linked issues and PRs. Finished children may require Activity view or a
   direct thread route.

Every project has one main-checkout orchestrator. Implementors with separate checkouts precede
main-checkout Reviewers, Investigators and Checkers; native helpers share their parent's checkout.
Titles explain expected behavior; they do not change sidebar sorting or role inference.

## Rebuild and restore

Run from the checkout containing the seed code you intend to use:

```sh
scripts/fork-dev/seed.sh        # full rebuild: mock repos, fresh database, all examples
scripts/fork-dev/seed.sh start  # start on existing data, then restore live work
scripts/fork-dev/seed.sh live   # restore live work after any server restart
scripts/fork-dev/preview.sh open  # owner's action: preview current main in fork-sandbox
scripts/fork-dev/preview.sh close
```

After changing the layout, run a **full rebuild**. `start` and `live` do not rebuild projects,
lineage or worktrees. The server always executes code from `fork-sandbox`, so that checkout must
also contain the sampler change. `preview.sh open` puts it on `main` and starts it using main's
seed. The orchestrator should merge changes before rebuilding the owner's preview.

A full rebuild removes only the seed's known old/new mock directories, replaces the dev
`statev2.sqlite` and environment ID, and starts `t3-dev`. It preserves the GitHub sandbox clone.
`github.py` still runs first to maintain the real sandbox issues/PRs. Reseed every few days:
timestamps are relative to seed time and the server auto-settles inactive threads after three days.
Generated files live in `~/Workspaces-Dev/.t3-dev-fixture/`, outside the repository.

## Process fixture

Only `seed.sh`'s `start_dev` opts the **t3-dev unit** into
`T3CODE_DEV_PROCESS_FIXTURE=~/Workspaces-Dev/.t3-dev-fixture/processes.json` (an absolute path).
Full rebuild and `start` use that launcher; `preview.sh open` calls `start`. `live` rewrites the
fixture with fresh process times alongside the running command rows and output files.

The JSON contains fake PIDs, parent PIDs, command lines, start times, CPU percentages and resident
bytes. A root parent of `"server"` resolves to the current server PID when sampled. Commands
match the seeded running commands exactly, so the real attribution and `groupSpawnedProcesses`
code computes groups, members and totals. Nothing launches those commands. The fixture also
works when native telemetry is unhealthy; a missing/invalid fixture yields no process sample.
With the variable unset, normal native telemetry is unchanged. No production launcher sets it.
These samples affect thread process rows and task usage, not the environment's real process monitor.

## Offline checks

These do not start a server, touch the running preview, access GitHub or read the live T3 home:

```sh
python3 -m py_compile scripts/fork-dev/seed.py scripts/fork-dev/check.py
python3 scripts/fork-dev/check.py
# Optional: copy an empty migrated database into the check's temporary sandbox, then base/live/live:
python3 scripts/fork-dev/check.py /absolute/path/to/empty-migrated.sqlite
```

The check uses temporary files and local Git checkpoints, validates project owners, parentage,
labels, native types, process commands, sections and PR states. With the optional database it also
checks SQL writes, repeated live restoration, SQLite integrity and foreign keys. It never modifies
the supplied database. `shot.mjs` keeps direct routes to labeled examples for optional screenshots;
`icon-review.cjs` produces the optional icon inventory.

## Traps and real actions

- **Restarts cancel live work:** running runs, native subagents, background tasks and approvals.
  Run `seed.sh live` after startup recovery. Pending questions and open delegated-task cards
  survive. Only a unit launched by the updated `seed.sh` has the fixture variable.
- **Mock controls can start real agents:** answering a question, selecting **Implement** on a
  plan or selecting **Resume at reset** on the Limited row sends a real turn. Nothing starts
  automatically: there are no provider sessions or node forks, and usage recovery has
  auto-resume disabled. Stop/approval responses require a live provider session and fail
  harmlessly for these rows. Process-detail actions follow mock output; the PIDs are synthetic.
- **Output:** Codex logs are under the dev server's `userdata/logs/background-tasks`; Claude
  output files are under the fixture's `tasks/` directory. They contain sample text.
- **Settings:** `worktreesDirectory: "project-local"` and `addProjectBaseDirectory` point new
  worktrees at the mock workspace. Worktree README edits prevent storage cleanup from deleting
  them. `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=0` prevents an extra server project.
- **Fake remotes:** `https://github.com/t3-dev-mock/<repo>.git` identifies mock repos; no branch
  tracks them. GitHub lookups return 404 and log warnings; seeded PR snapshots remain.
- **Real GitHub sandbox:** `github.py` maintains the existing issue hierarchy (#13–#20), blocked
  chains, completed/not-planned examples, milestone `02 - Release 1.0`, priority labels,
  cross-project inbox issues #21/#22, and PRs #23 (merged), #24 (open), #25 (draft), as well as
  older #1–#12 data. Run it before starting the fresh database: the issue inbox labels newly
  observed issues on GitHub even while repository work is paused. The repository clone only
  fetches; `seed.py` uses read-only API calls for repository/linked-issue metadata.
- **Passive repository work:** `paused=1`, no milestones, worker limit 1 (the minimum), and both
  publish flags off prevent admission, scheduled work and comments. **Resume repository work**
  or **Work through milestone** starts real agents.
- **Issues pane:** lists the `gh` account's real repositories too and can take 15–40 seconds.
  Use the sandbox project or `/issues?host=github.com&repository=tannerpolley/t3code-sandbox`.
  Roadmap shows dependency/worker colors; the full page shows gray closed rows with Closed on.
- **Views:** Projects nests active children and hides finished ones; Activity and direct routes
  retain the finished examples. The section and ordering fixtures exercise the real client.
