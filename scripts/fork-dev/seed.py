#!/usr/bin/env python3
"""Mock rows for the fork-sandbox dev database. Run through seed.sh.

  seed.py base   with t3-dev stopped: projects, threads, finished runs and their timelines,
                 plans, questions, pull requests, an issue link, sections.
  seed.py live   with t3-dev running: Working runs, running native subagents, background
                 tasks and their output files, pending approvals.

Server start cancels live runs, native subagents, background tasks and approvals, so `live`
must run after the server is up. No row has a provider thread or session, children have no
node fork, and the usage-limited thread's recovery is pre-armed with auto-resume off, so the
server never starts a provider on its own. Answering the pending questions does send a real
message, like any message typed in the dev app.
"""
import base64
import functools
import difflib
import hashlib
import json
import os
import subprocess
import tempfile
import sqlite3
import sys
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path.home()
ROOT = HOME / "Workspaces-Dev"
FIXTURE = ROOT / ".t3-dev-fixture"  # generated output only (Claude task files, screenshots)
USERDATA = HOME / "Workspaces/Applications/t3code/.worktrees/fork-sandbox/.t3/userdata"
DB = USERDATA / "statev2.sqlite"
LIVE_DB = HOME / ".t3/userdata/statev2.sqlite"
NOW = datetime.now(timezone.utc)


def iso(moment):
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def at(**ago):
    """ISO time `ago` before now; negative values are in the future."""
    return iso(NOW - timedelta(**ago))


def uid(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"t3-dev-mock/{name}"))


def enc(value):
    return urllib.parse.quote(value, safe="-_.!~*'()")


def b64(value):
    return base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")


PROJECTS = {
    "processes": ("01 · Processes and background work", "Showcase/processes"),
    "families": ("02 · Thread families and separators", "Showcase/families"),
    "roles": ("03 · Roles and native subagents", "Showcase/roles"),
    "statuses": ("04 · Statuses and attention", "Showcase/statuses"),
    "badges": ("05 · PR badges and checkpoint diffs", "Showcase/badges"),
    "workflow": ("06 · Questions, plans and task lists", "Showcase/workflow"),
    "sections": ("07 · Sections and plain folders", "Notes/sections"),
    "sandbox": ("08 · GitHub issues · t3code-sandbox", "GitHub/t3code-sandbox"),
}
SANDBOX_REPO = "tannerpolley/t3code-sandbox"
PID = {key: uid(f"project/{key}") for key in PROJECTS}


def wt(project, branch):
    return str(ROOT / PROJECTS[project][1] / ".worktrees" / branch.replace("/", "-"))


def pr(repo, number, state, title, head, *, draft=False, checks=None, review=None,
       mergeable="mergeable", diff=(12, 3, 2), owner="t3-dev-mock"):
    """A pull request link with the snapshot the sync reactor would have stored. Real sandbox
    PRs (owner tannerpolley) are refreshed from GitHub by the sync reactor."""
    return {
        "host": "github.com", "repository": f"{owner}/{repo}", "number": number,
        "url": f"https://github.com/{owner}/{repo}/pull/{number}", "source": "agent",
        "linkedAt": at(hours=2),
        "snapshot": {
            "state": state, "title": title, "headBranch": head, "baseBranch": "main",
            "isDraft": draft, "updatedAt": at(hours=1), "syncedAt": at(minutes=5),
            "closedAt": at(days=5) if state != "open" else None,
            "mergedAt": at(days=5) if state == "merged" else None,
            "author": {"login": "t3-dev-mock", "name": "T3 Dev Mock", "avatarUrl": None},
            "additions": diff[0], "deletions": diff[1], "changedFiles": diff[2],
            "reviewDecision": review, "checksState": checks, "mergeability": mergeable,
        },
        "stack": None,
    }


@functools.cache
def github(path):
    """A read-only GitHub API GET through the owner's gh login."""
    return json.loads(subprocess.run(["gh", "api", path], capture_output=True, text=True,
                                     check=True).stdout)


def sandbox_issue(number):
    repo, issue = github(f"repos/{SANDBOX_REPO}"), github(f"repos/{SANDBOX_REPO}/issues/{number}")
    return {"host": "github.com", "repository": SANDBOX_REPO, "repositoryId": str(repo["id"]),
            "id": str(issue["id"]), "nodeId": issue["node_id"], "number": number,
            "url": issue["html_url"], "title": issue["title"]}


C, X = "claudeAgent", "codex"
LONG_TITLE = (
    "Reconcile boundary-condition handling between the legacy Fortran cascade kernel and the "
    "new vectorized NumPy path so the periodic-grid regression suite stops drifting"
)
LIMIT_RESET = at(hours=-3)


@functools.cache
def native_role(agent_type):
    # Use the adapter's mapping so native examples follow role changes in the checkout being seeded.
    module = Path(__file__).resolve().parents[2] / "packages/contracts/src/threadRole.ts"
    source = (f"import {{ nativeSubagentRole }} from {json.dumps(module.as_uri())}; "
              f"console.log(JSON.stringify(nativeSubagentRole({json.dumps(agent_type)})));")
    return json.loads(subprocess.run(["node", "--input-type=module", "-e", source],
                                     capture_output=True, text=True, check=True).stdout)


# Existing timeline keys stay stable for screenshots and checkpoint identities. Every title is
# also the sidebar role's hover checklist; kinds and roles use the real production contracts.
def example(key, project, check, *, role="investigator", parent=None, native=None,
            provider=X, created=None, **state):
    if created is None:
        created = max([state.get("live", 0)] +
                      [timedelta(**start).total_seconds() / 60
                       for start, _ in state.get("runs", [])]) + 2
    return dict(key=key, project=project, title=f"Check: {check}", role=native_role(native) if native else role,
                kind="native" if native else "child" if parent else "top",
                **({"parent": parent} if parent else {}),
                **({"agent_type": native} if native else {}),
                provider=provider, model="claude-sonnet-5-5" if provider == C else "gpt-6.1-sol",
                effort="medium", created=dict(minutes=created), **state)


def coordinator(key, project, check, **state):
    return example(key, project, check, role="orchestrator", created=1440, **state)


def checkout(project, branch):
    return dict(branch=branch, worktree=wt(project, branch))


FINISHED = [(dict(minutes=40), dict(minutes=30))]
THREADS = [
    coordinator("proc-orchestrate", "processes",
                "expand C++, Vite, pytest, Rust and Python; compare counts, CPU/memory, output and nested processes",
                live=25),
    example("proc-cpp", "processes",
            "C++ build: ccache, c++ and cc1plus each fold 16 members; open caret, click command details",
            role="implementor", parent="proc-orchestrate", live=24,
            **checkout("processes", "build/cpp")),
    example("proc-vite", "processes",
            "Vite: node and esbuild groups; click command output and check elapsed time and running marks",
            role="implementor", parent="proc-orchestrate", created=25, live=23,
            **checkout("processes", "dev/vite")),
    example("proc-rust", "processes",
            "Rust: 12 rustc members; process block ends with a dashed separator before the helper",
            role="implementor", parent="proc-orchestrate", created=26, live=22,
            **checkout("processes", "build/rust")),
    example("proc-nested-tests", "processes",
            "nested helper also owns pytest processes: eight xdist workers and a coverage reporter",
            role="checker", parent="proc-rust", provider=C, live=18,
            **checkout("processes", "build/rust")),
    example("cas-bench", "processes",
            "processes only: finished turn, Python benchmark plus monitor, CPU/memory and readable output; no agents",
            role="checker", parent="proc-orchestrate", provider=C, runs=FINISHED,
            visited=dict(minutes=29)),

    coordinator("fam-orchestrate", "families",
                "one root above role-ordered workers; newest Implementor first; nested helpers; Lines marks checkout changes",
                live=28),
    example("fam-new", "families", "newer Implementor sorts above the older one; dashed checkout boundary",
            role="implementor", parent="fam-orchestrate", created=12, live=11,
            **checkout("families", "feature/newer")),
    example("fam-old", "families", "older Implementor remains below the newer one; helper stays in this family",
            role="implementor", parent="fam-orchestrate", created=24, live=23,
            **checkout("families", "feature/older")),
    example("fam-helper", "families", "nested Investigator shares its parent's checkout; stays below that parent",
            parent="fam-old", native="explorer", live=10,
            **checkout("families", "feature/older")),
    example("fam-review", "families", "Reviewer follows Implementors, shares main; solid family and dashed checkout lines",
            role="reviewer", parent="fam-orchestrate", live=9),
    example("fam-investigate", "families", "Investigator follows Reviewer even though this row is newer",
            parent="fam-orchestrate", created=6, live=5),
    example("fam-check", "families", "Checker follows Investigator; main checkout needs no checkout-change dash",
            role="checker", parent="fam-orchestrate", created=4, live=3),
    example("fam-second-family", "families", "standalone family has a solid separator in Family style Lines",
            live=2),

    coordinator("role-orchestrate", "roles",
                "compare explicit Implementor/Reviewer/Investigator/Checker with Codex and Claude native types; inspect generic Worker label",
                live=29),
    example("role-build", "roles", "explicit app-owned Implementor has a separate checkout",
            role="implementor", parent="role-orchestrate", live=22,
            **checkout("roles", "feature/worker")),
    example("role-review", "roles", "explicit app-owned Reviewer keeps its role label",
            role="reviewer", parent="role-orchestrate", live=21),
    example("role-investigate", "roles", "explicit app-owned Investigator keeps its role label",
            parent="role-orchestrate", live=20),
    example("role-check", "roles", "explicit app-owned Checker keeps its role label",
            role="checker", parent="role-orchestrate", live=19),
    example("role-generic", "roles", "Claude general-purpose native agent: inspect generic Worker label and column width",
            parent="role-orchestrate", native="general-purpose", provider=C, live=17),
    example("role-worker", "roles", "Codex worker native agent: inspect Worker label; helper belongs to this worker",
            parent="role-build", native="worker", live=16,
            **checkout("roles", "feature/worker")),
    example("role-explorer", "roles", "Codex explorer native agent maps to Investigator",
            parent="role-orchestrate", native="explorer", live=15),
    example("role-explore", "roles", "Claude Explore native agent maps to Investigator",
            parent="role-orchestrate", native="Explore", provider=C, live=14),
    example("role-native-review", "roles", "Claude code-reviewer native agent maps to Reviewer",
            parent="role-orchestrate", native="code-reviewer", provider=C, live=13),
    example("role-native-check", "roles", "Codex tester native agent maps to Checker",
            parent="role-orchestrate", native="tester", live=12),

    coordinator("status-orchestrate", "statuses",
                "compare Working, Waiting, Done, idle, settled, Approval, Input, Failed, Limited, snoozed, Woke, pinned and archived",
                live=27),
    example("status-working", "statuses", "Working: active Codex turn and running mark",
            role="implementor", parent="status-orchestrate", live=10,
            **checkout("statuses", "feature/working")),
    example("status-waiting", "statuses", "Waiting: completed parent turn waits for an active delegated Checker",
            runs=FINISHED, visited=dict(minutes=29)),
    example("status-waiting-child", "statuses", "active child keeps its finished parent Waiting",
            role="checker", parent="status-waiting", live=9),
    example("status-done", "statuses", "Done: completed but unseen; open the row to clear unseen state",
            runs=FINISHED, visited=dict(minutes=41)),
    example("status-idle", "statuses", "idle: completed and already visited; compare with Done", runs=FINISHED,
            visited=dict(minutes=29)),
    example("status-settled", "statuses", "settled: explicitly parked row; inspect Activity and settled filters",
            runs=FINISHED, visited=dict(minutes=29), settled=dict(minutes=28)),
    example("bor-stale-branches", "statuses", "Approval: pending branch-delete command; inspect permission card",
            role="implementor", parent="status-orchestrate", live=12,
            **checkout("statuses", "chore/stale-branches")),
    example("status-input", "statuses", "Input: pending single-choice request; answering starts a real turn",
            provider=C, runs=FINISHED),
    example("ech-ci-matrix", "statuses", "Failed: disconnected provider, error card and retry action",
            role="implementor", runs=FINISHED, visited=dict(minutes=29),
            failure={"class": "provider_error", "message": "The model stream ended before the turn completed.",
                     "code": "responseStreamDisconnected", "retryable": True},
            **checkout("statuses", "ci/matrix")),
    example("aur-theme-layers", "statuses", "Limited: usage-limit card and reset time; auto-resume is off",
            role="implementor", provider=C, runs=FINISHED, visited=dict(minutes=29),
            failure={"class": "usage_limit", "message": "Claude usage limit reached. Resets in about 3 hours.",
                     "code": "rate_limit_error", "retryable": True, "resetAt": LIMIT_RESET},
            **checkout("statuses", "refactor/theme-layers")),
    example("status-snoozed", "statuses", "snoozed: future wake time; inspect snoozed filter and unsnooze",
            runs=FINISHED, visited=dict(minutes=29), snoozed=(dict(hours=-18), dict(minutes=28))),
    example("ech-readme-badges", "statuses", "Woke: expired snooze returns the thread to attention",
            runs=FINISHED, visited=dict(minutes=29), snoozed=(dict(minutes=5), dict(minutes=28))),
    example("status-pinned", "statuses", "pinned: row stays in the pinned area; try unpin",
            runs=FINISHED, visited=dict(minutes=29), pinned=True),
    example("status-archived", "statuses", "archived: hidden until the archived filter is on; try reopen",
            runs=FINISHED, visited=dict(minutes=29), archived=dict(minutes=28)),

    coordinator("badge-orchestrate", "badges", "123-PR badge; open/draft/merged/closed states; checks, reviews and checkpoint diff",
                prs=[pr("badges", n, "merged", f"Sidebar refinement {n}", f"sidebar/refinement-{n}",
                        checks="passing", review="approved") for n in range(100, 223)]),
    example("aur-login-timeout", "badges", "open PR: passing checks, review required; inspect checkpoint Diff and inline shell result",
            role="implementor", runs=FINISHED, visited=dict(minutes=41),
            prs=[pr("badges", 12, "open", "Raise login timeout and retry once", "fix/login-timeout",
                    checks="passing", review="review-required")], **checkout("badges", "fix/login-timeout")),
    example("badge-draft", "badges", "draft PR: failing checks, conflicting merge and changed-file counts",
            role="implementor", parent="badge-orchestrate", live=9,
            prs=[pr("badges", 4, "open", "Vectorize the solver", "experiment/fast-solver", draft=True,
                    checks="failing", mergeable="conflicting", diff=(212, 97, 6))],
            **checkout("badges", "experiment/fast-solver")),
    example("badge-merged", "badges", "merged PR: approved review and passing checks", runs=FINISHED,
            visited=dict(minutes=29), prs=[pr("badges", 9, "merged", "Upgrade Vite", "chore/vite-7",
                                           checks="passing", review="approved")]),
    example("badge-closed", "badges", "closed PR: unmerged and failing checks", runs=FINISHED,
            visited=dict(minutes=29), prs=[pr("badges", 3, "closed", "Try CI matrix", "ci/matrix", checks="failing")]),

    coordinator("aur-orchestrate", "workflow", "Claude task list above composer; single-choice and multi-select questions; proposed plan and plan mode",
                provider=C, runs=FINISHED, live=24),
    example("cas-charting", "workflow", "Claude single-choice: two questions, recommendations and custom answer",
            parent="aur-orchestrate", provider=C, runs=FINISHED),
    example("bor-release-checks", "workflow", "Codex multi-select: choose several release gates before submitting",
            role="checker", parent="aur-orchestrate", runs=FINISHED),
    example("bor-plugin-plan", "workflow", "plan mode: proposed plugin plan and Implement action; action starts real work",
            plan=True, provider=C, runs=FINISHED, visited=dict(minutes=29)),

    coordinator("section-orchestrate", "sections", "folder subsection, unsectioned project and empty INBOX; plain folder has no Git branch", branch=None),
    example("section-notes", "sections", "plain-folder Investigator: no Git or checkout badge", parent="section-orchestrate",
            branch=None, live=5),
    example("cas-boundary", "sections", "long title truncates cleanly; hover reveals the full checklist: " + LONG_TITLE,
            branch=None, runs=FINISHED, visited=dict(minutes=29), settled=dict(minutes=28)),

    coordinator("gh-orchestrator", "sandbox", "real issues #6/#7 Working/Input, #15 open PR #24; roadmap and dependency colors; repository work paused",
                provider=C, runs=[(dict(hours=2), dict(hours=1, minutes=50)),
                                  (dict(hours=1, minutes=42), dict(hours=1, minutes=8))],
                visited=dict(hours=1, minutes=5), orchestrates=True),
    example("gh-issue-6", "sandbox", "issue #6 Working: blue in the Issues roadmap", role="implementor",
            parent="gh-orchestrator", gh_issue=6, live=16, **checkout("sandbox", "t3/issue-6-k-to-c")),
    example("gh-issue-7", "sandbox", "issue #7 Input: blue in roadmap; open rounding question", role="implementor",
            parent="gh-orchestrator", gh_issue=7, provider=C, runs=FINISHED,
            **checkout("sandbox", "t3/issue-7-f-to-k")),
    example("gh-issue-15", "sandbox", "issue #15 Done: real open PR #24 closes the issue; inspect Thread details",
            role="implementor", parent="gh-orchestrator", gh_issue=15, runs=FINISHED,
            prs=[pr("t3code-sandbox", 24, "open", "Reject temperatures below absolute zero", "fix/absolute-zero",
                    owner="tannerpolley", review="review-required", diff=(6, 0, 1))],
            **checkout("sandbox", "fix/absolute-zero")),
]
BY_KEY = {spec["key"]: spec for spec in THREADS}


def thread_id(spec):
    key = spec["key"]
    if spec["kind"] == "child":
        return f"thread:delegated-task:command%3Amcp%3A{uid(key)}%3Adelegate-task%3A{key}"
    if spec["kind"] == "native":
        return f"thread:provider:{spec['provider']}:native-thread:{uid(key)}"
    return uid(f"thread/{key}")


def root_of(spec):
    while spec.get("parent"):
        spec = BY_KEY[spec["parent"]]
    return thread_id(spec)


def model_selection(spec):
    option = "effort" if spec["provider"] == C else "reasoningEffort"
    return {"instanceId": spec["provider"], "model": spec["model"],
            "options": [{"id": option, "value": spec["effort"]}]}


def run_count(spec):
    return len(spec.get("runs", []))


def live_ordinal(spec):
    return run_count(spec) + 1


def run_id(spec, ordinal):
    return f"run:thread:{enc(thread_id(spec))}:ordinal:{ordinal}"


def root_node(spec, ordinal):
    return f"node:run:{enc(run_id(spec, ordinal))}:root"


def user_message_id(spec, ordinal):
    return f"message:mock:{uid(run_id(spec, ordinal))}"


def run_window(spec, ordinal):
    if ordinal <= run_count(spec):
        start, end = spec["runs"][ordinal - 1]
        return NOW - timedelta(**start), NOW - timedelta(**end)
    return NOW - timedelta(minutes=spec["live"]), NOW


def run_row(spec, ordinal, status):
    tid, rid = thread_id(spec), run_id(spec, ordinal)
    start, end = run_window(spec, ordinal)
    completed = None if status == "running" else iso(end)
    payload = {
        "id": rid, "threadId": tid, "ordinal": ordinal, "providerInstanceId": spec["provider"],
        "modelSelection": model_selection(spec), "providerThreadId": None,
        "userMessageId": user_message_id(spec, ordinal), "rootNodeId": root_node(spec, ordinal),
        "activeAttemptId": None, "status": status, "queuePosition": None,
        "requestedAt": iso(start), "startedAt": iso(start), "completedAt": completed,
        "checkpointId": None, "contextHandoffId": None,
    }
    return (rid, tid, ordinal, spec["provider"], None, status, iso(start), completed,
            json.dumps(payload), spec["provider"])


def finished_runs(spec):
    return [run_row(spec, n, "failed" if n == run_count(spec) and "failure" in spec else "completed")
            for n in range(1, run_count(spec) + 1)]


def thread_row(spec):
    tid = thread_id(spec)
    if "gh_issue" in spec:
        spec["linked_issue"] = sandbox_issue(spec["gh_issue"])

    created = at(**spec["created"])
    times = [created] + [at(**t) for run in spec.get("runs", []) for t in run]
    for field in ("visited", "settled", "archived"):
        if field in spec:
            times.append(at(**spec[field]))
    if "live" in spec:
        times.append(at(minutes=spec["live"]))
    updated = max(times)
    parent = BY_KEY.get(spec.get("parent"))
    snoozed = spec.get("snoozed")
    archived = at(**spec["archived"]) if "archived" in spec else None
    payload = {
        "role": spec["role"],
        "titleSource": "generated",
        "createdBy": "user" if spec["kind"] == "top" else "agent",
        "creationSource": {"top": "web", "child": "mcp", "native": "provider"}[spec["kind"]],
        "id": tid, "projectId": PID[spec["project"]], "title": spec["title"],
        "providerInstanceId": spec["provider"], "modelSelection": model_selection(spec),
        "runtimeMode": "full-access", "interactionMode": "plan" if spec.get("plan") else "default",
        "branch": spec.get("branch", "main"), "worktreePath": spec.get("worktree"),
        **({"linkedIssue": spec["linked_issue"]} if "linked_issue" in spec else {}),
        **({"repositoryOrchestration": repository_orchestration()} if spec.get("orchestrates") else {}),
        "linkedPullRequest": None, "pullRequests": spec.get("prs", []),
        "activeProviderThreadId": None,
        "lineage": {
            "parentThreadId": thread_id(parent) if parent else None,
            "relationshipToParent": "subagent" if parent else None,
            "rootThreadId": root_of(spec),
        },
        # Kept null: a node fork would make restart recovery deliver results to the parent.
        "forkedFrom": None,
        "createdAt": created, "updatedAt": updated, "archivedAt": archived,
        "settledOverride": "settled" if "settled" in spec else None,
        "settledAt": at(**spec["settled"]) if "settled" in spec else None,
        "snoozedUntil": at(**snoozed[0]) if snoozed else None,
        "snoozedAt": at(**snoozed[1]) if snoozed else None,
        "pinnedAt": at(days=1) if spec.get("pinned") else None,
        "pinOrderKey": "a0" if spec.get("pinned") else None,
        "activeOrderKey": None,
        "lastVisitedAt": at(**spec["visited"]) if "visited" in spec else None,
        "titleRegeneration": None, "deletedAt": None,
    }
    failure = spec.get("failure")
    if failure and failure["class"] == "usage_limit":
        # Pre-armed with auto-resume off: the recovery sweep sees its own decision and never
        # resumes the thread at the reset time.
        payload["limitRecovery"] = {"runId": run_id(spec, run_count(spec)),
                                    "resetAt": failure["resetAt"], "autoResume": False,
                                    "snooze": False}
    return (tid, PID[spec["project"]], spec["title"], spec["provider"], "full-access",
            payload["interactionMode"], None, created, updated, archived, None,
            json.dumps(payload), spec["provider"])


def repository_orchestration():
    """Passive by construction: `paused` stops admission and the reconcile loop, an empty
    milestone list keeps the root out of the scheduler, and both publish flags are off, so no
    comment effect is ever queued. worker_limit has a database minimum of 1."""
    repo = github(f"repos/{SANDBOX_REPO}")
    return {"host": "github.com", "repository": SANDBOX_REPO, "repositoryId": str(repo["id"]),
            "projectId": PID["sandbox"], "launchCommandId": "command:mock:sandbox-orchestrator",
            "revision": 1, "paused": True, "workerLimit": 1, "publishStatusComments": False,
            "publishCloseoutComments": False, "milestones": [], "suspendedIssues": []}


def native_subagent_row(spec):
    """The provider-native task on the parent's live run; the child's status comes from here."""
    parent = BY_KEY[spec["parent"]]
    parent_run = run_id(parent, live_ordinal(parent))
    sid = f"node:provider:{spec['provider']}:native-item:{uid(spec['key'])}"
    started = at(minutes=spec["live"])
    payload = {
        "id": sid, "threadId": thread_id(parent), "runId": parent_run,
        "parentNodeId": root_node(parent, live_ordinal(parent)), "origin": "provider_native",
        "createdBy": "agent", "driver": spec["provider"], "providerInstanceId": spec["provider"],
        "providerThreadId": None, "childThreadId": thread_id(spec),
        "nativeTaskRef": {"driver": spec["provider"], "nativeId": uid(spec["key"] + "/task"),
                          "strength": "strong"},
        "prompt": f"{spec['title']} and report what you find.", "title": spec["title"],
        "model": spec["model"], "modelSelection": model_selection(spec), "status": "running",
        "result": None, "startedAt": started, "completedAt": None, "updatedAt": at(minutes=1),
    }
    return (sid, thread_id(parent), parent_run, payload["parentNodeId"], spec["provider"], None,
            thread_id(spec), "provider_native", "running", started, None, payload["updatedAt"],
            json.dumps(payload), spec["provider"], spec["provider"])


# Timelines: (run ordinal, item) pairs; `live=True` marks work restart recovery cancels.
# Background shells name their output file: Codex logs live under the server's logs dir,
# Claude's under a tasks dir its tool result reports.
def user(text, by="user"):
    return {"type": "user_message", "text": text, "by": by}


def say(text, shell=None):
    return {"type": "assistant_message", "text": text, "shell": shell}


def think(text):
    return {"type": "reasoning", "text": text, "title": "Thinking"}


def cmd(command, output, exit_code=0, **extra):
    return {"type": "command_execution", "input": command, "output": output,
            "exitCode": exit_code, "status": "completed" if exit_code == 0 else "failed", **extra}


def bg(command, native, log, **extra):
    return {"type": "command_execution", "input": command, "status": "running", "native": native,
            "log": log, "live": True, **extra}


def edit(path, diff, adds, dels):
    return {"type": "file_change", "fileName": path, "diffStr": diff, "additions": adds,
            "deletions": dels}


def child_card(child_key, prompt, live=False):
    return {"type": "subagent", "child": child_key, "prompt": prompt, "status": "running",
            "live": live}


AURORA_LOGIN = wt("badges", "fix/login-timeout")
OLD_LOGIN = """import { DEFAULT_TIMEOUT_MS, request } from "./http";
import { parseSession } from "./session";

export interface LoginBody {
  readonly email: string;
  readonly password: string;
}

export async function login(body: LoginBody) {
  const res = await request("/api/login", { body, timeoutMs: DEFAULT_TIMEOUT_MS });
  return parseSession(res);
}
"""
NEW_LOGIN = """import { isTimeout, request } from "./http";
import { parseSession } from "./session";

export interface LoginBody {
  readonly email: string;
  readonly password: string;
}

export async function login(body: LoginBody) {
  const options = { body, timeoutMs: LOGIN_TIMEOUT_MS };
  // Slow networks often drop the first attempt; one retry covers them.
  const res = await request("/api/login", options).catch((error) =>
    isTimeout(error) ? request("/api/login", options) : Promise.reject(error),
  );
  return parseSession(res);
}

const LOGIN_TIMEOUT_MS = 30_000;
"""
OLD_HTTP = """export const DEFAULT_TIMEOUT_MS = 5_000;

export async function request(path: string, options: RequestOptions) {
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return fetch(path, { method: "POST", body: JSON.stringify(options.body), signal });
}
"""
NEW_HTTP = OLD_HTTP.replace("\n\nexport async", """

export const isTimeout = (error: unknown) =>
  error instanceof DOMException && error.name === "TimeoutError";

export async""", 1)
# Before and after snapshots of the login fix; the Diff panel reads them from checkpoint refs.
LOGIN_FILES = {"src/login.ts": (OLD_LOGIN, NEW_LOGIN), "src/http.ts": (OLD_HTTP, NEW_HTTP)}


def file_diff(path):
    old, new = LOGIN_FILES[path]
    lines = list(difflib.unified_diff(old.splitlines(True), new.splitlines(True), n=2))[2:]
    adds = sum(line.startswith("+") for line in lines)
    dels = sum(line.startswith("-") for line in lines)
    return "".join(lines), adds, dels


LOGIN_SUMMARY = """Fixed. The login request used the shared **5 s** default timeout, which hotel and airplane Wi-Fi regularly exceed.

### What changed
- `src/login.ts` now has its own `LOGIN_TIMEOUT_MS` of **30 s** and retries once after a timeout.
- `src/http.ts` exports `isTimeout()`, so the retry fires only for timeouts, never for a 401.

| Check | Before | After |
|---|---|---|
| `src/login.test.ts` | 3 of 4 pass | 4 of 4 pass |
| Login on a throttled 3G profile | times out at 5 s | succeeds in about 9 s |

Run the focused test yourself:

```bash
pnpm vitest run src/login.test.ts
```

Open [#12](https://github.com/t3-dev-mock/badges/pull/12) for the mock PR snapshot. The Processes project has the Vite background-work example."""
PLUGIN_PLAN = """# Borealis plugin API

## Goals
- Let third parties add subcommands without forking borealis.
- Keep startup under 50 ms when no plugins are installed.

## Design
1. Discover plugins through the `borealis.plugins` entry-point group.
2. Load lazily: import a plugin only when its subcommand runs.
3. Version the hook interface (`api_version = 1`) and refuse newer major versions.

```python
class Plugin(Protocol):
    name: str
    api_version: int

    def register(self, cli: click.Group) -> None: ...
```

## Steps
- [ ] Add the entry-point loader and a `borealis plugins list` command
- [ ] Document the hook interface in `docs/plugins.md`
- [ ] Ship one example plugin in `examples/hello-plugin`

## Risks
- Entry-point scanning adds cold-start cost; measure before and after."""
CHARTING_TABLE = """Here is how the main options compare for an HTML report that has to stay interactive:

| Library | Interactive zoom | Offline bundle | Notes |
|---|---|---|---|
| **Plotly** | Yes | ~3.5 MB | Best hover tooltips; heavy bundle |
| **Vega-Lite** | Yes | ~0.8 MB | Declarative specs; smallest offline build |
| **Matplotlib** | No | n/a | Static PNGs; matches the paper figures |

I need two decisions from you before I wire one in."""

TIMELINES = {
    "aur-login-timeout": [
        (1, user("Users on hotel Wi-Fi get logged out mid-login. Find why the login request times "
                 "out and fix it on this branch. Keep the change small and add a test.")),
        (1, think("The timeout probably comes from the shared fetch wrapper. I'll check the login "
                  "client and its tests before changing anything.")),
        (1, cmd("/bin/bash -lc \"rg -n 'timeout' src/login.ts src/http.ts\"",
                "src/http.ts:1:export const DEFAULT_TIMEOUT_MS = 5_000;\n"
                "src/login.ts:12:  const res = await request(\"/api/login\", { body, timeoutMs: DEFAULT_TIMEOUT_MS });\n")),
        (1, cmd("/bin/bash -lc \"pnpm vitest run src/login.test.ts\"",
                " FAIL  src/login.test.ts > login > retries once after a timeout\n"
                "AssertionError: expected \"request\" to be called 2 times, but got 1 times\n"
                " ❯ src/login.test.ts:41:29\n\n Test Files  1 failed (1)\n"
                "      Tests  1 failed | 3 passed (4)\n", exit_code=1)),
        (1, edit(f"{AURORA_LOGIN}/src/login.ts", *file_diff("src/login.ts"))),
        (1, edit(f"{AURORA_LOGIN}/src/http.ts", *file_diff("src/http.ts"))),
        (1, cmd("/bin/bash -lc \"pnpm vitest run src/login.test.ts\"",
                " ✓ src/login.test.ts (4 tests) 38ms\n\n Test Files  1 passed (1)\n"
                "      Tests  4 passed (4)\n")),
        (1, cmd("/bin/bash -lc \"gh pr create --title 'Raise the login timeout and retry once' --fill\"",
                "https://github.com/t3-dev-mock/badges/pull/12\n")),
        (1, say(LOGIN_SUMMARY, shell={"output": " ✓ src/login.test.ts (4 tests) 41ms\n\n"
                                               " Test Files  1 passed (1)\n      Tests  4 passed (4)\n"})),
        (1, {"type": "checkpoint"}),
    ],
    "aur-orchestrate": [
        (1, user("Prepare the release: compare reporting libraries, choose release gates and draft a plugin plan.")),
        (1, say("The release checklist is ready; decisions and implementation remain separate.")),
        (2, user("Track the work and ask for the remaining decisions.")),
        (2, {"type": "todo_list", "explanation": "Completed, running and pending steps stay visible above the composer.",
             "steps": [("Inventory existing checks", "completed"),
                       ("Choose the chart library", "running"),
                       ("Choose release gates", "running"),
                       ("Implement the accepted plugin plan", "pending")]}),
        (2, child_card("cas-charting", "Ask which report library to use.", live=True)),
        (2, child_card("bor-release-checks", "Ask which checks should block the release.", live=True)),
    ],
    "bor-stale-branches": [
        (1, user("Delete remote release branches older than 1.0 that are fully merged.")),
        (1, cmd("/bin/bash -lc \"git branch -r --merged origin/main\"",
                "  origin/release/0.8\n  origin/release/0.9\n  origin/release/1.2\n")),
        (1, {"type": "approval_request", "requestKind": "command",
             "prompt": "git push origin --delete release/0.8 release/0.9"}),
    ],
    "bor-plugin-plan": [
        (1, user("Plan a plugin API for borealis. Don't write code yet.")),
        (1, think("Entry points keep plugins installable with pip; lazy loading keeps startup fast.")),
        (1, {"type": "proposed_plan", "markdown": PLUGIN_PLAN}),
        (1, say("The plan is ready. Choose **Implement** to start, or tell me what to change.")),
    ],
    "cas-charting": [
        (1, user("We need interactive convergence plots in the cascade-sim report. Compare the "
                 "options and ask me before picking one.")),
        (1, say(CHARTING_TABLE)),
        (1, {"type": "user_input_request", "questions": [
            {"id": "library", "header": "Library",
             "question": "Which charting library should the report use?",
             "options": [
                 {"label": "Vega-Lite (Recommended)", "description": "Interactive, smallest offline bundle."},
                 {"label": "Plotly", "description": "Richest hover tooltips, 3.5 MB bundle."},
                 {"label": "Matplotlib", "description": "Static images that match the paper."}],
             "multiSelect": False, "allowCustomAnswer": True},
            {"id": "offline", "header": "Offline",
             "question": "Must the report work without a network connection?",
             "options": [{"label": "Yes", "description": "Inline the library in the HTML."},
                         {"label": "No", "description": "Load it from a CDN."}],
             "multiSelect": False}]}),
    ],
    "aur-theme-layers": [
        (1, user("Move the theme tokens into @layer tokens so component styles stop fighting them.")),
        (1, edit(f"{wt('statuses', 'refactor/theme-layers')}/src/theme.css", json.dumps({
            "filePath": f"{wt('statuses', 'refactor/theme-layers')}/src/theme.css",
            "oldString": ":root {\n  --sidebar-bg: #0b1020;\n  --sidebar-fg: #e6e9f2;",
            "newString": "@layer tokens {\n  :root {\n    --sidebar-bg: #0b1020;\n    --sidebar-fg: #e6e9f2;",
            "replaceAll": False}), 4, 3)),
        (1, {"type": "error", "title": "Usage limit reached"}),
    ],
    "ech-ci-matrix": [
        (1, user("Move CI to a matrix over Python 3.11 to 3.13 and Node 20 and 22.")),
        (1, edit(f"{wt('statuses', 'ci/matrix')}/.github/workflows/ci.yml",
                 "@@ -0,0 +1,12 @@\n+name: ci\n+on: [push, pull_request]\n+jobs:\n+  test:\n"
                 "+    strategy:\n+      matrix:\n+        python: [\"3.11\", \"3.12\", \"3.13\"]\n"
                 "+        node: [20, 22]\n+    runs-on: ubuntu-latest\n+    steps:\n"
                 "+      - uses: actions/checkout@v4\n+      - run: make test\n", 12, 0)),
        (1, cmd("/bin/bash -lc \"act -j test --matrix python:3.13\"",
                "Error: Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n",
                exit_code=1)),
        (1, {"type": "error", "title": "Provider error"}),
    ],
    "cas-bench": [
        (1, user("Benchmark the three grid sizes in the background and report when done.", by="agent")),
        (1, bg("uv run python scripts/bench.py --cells 1000,10000,100000", "toolu_mockbench01",
               "grid=1000    variant=numpy  median=0.84s\ngrid=1000    variant=numba  median=0.11s\n"
               "grid=10000   variant=numpy  median=8.91s\ngrid=10000   variant=numba  median=0.97s\n"
               "grid=100000  variant=numpy  running…\n", claude=True)),
        (1, {"type": "dynamic_tool", "toolName": "Monitor", "title": "Watch benchmark progress",
             "status": "running", "live": True, "native": "toolu_mockmonitor01",
             "input": {"command": "tail -f results/bench.log", "description": "Watch benchmark progress"},
             "output": {"taskId": "bmon01"}}),
        (1, bg("tail -f results/bench.log", "toolu_mocktail01",
               "[monitor] grid=100000 still running; last sample 9.7s\n", claude=True)),
        (1, say("The 1k and 10k grids are done (Numba is about 9x faster). The 100k grid is still "
                "running in the background; I'm watching its log.")),
    ],
}
TIMELINES |= {
    "bor-release-checks": [
        (1, user("Before I tag 1.2, which checks should block the release? Ask me; several can "
                 "apply.")),
        (1, cmd("/bin/bash -lc \"ls .github/workflows\"", "ci.yml\ndocs.yml\nrelease.yml\n")),
        (1, say("CI can run four checks before tagging. Tick every one that should block it.")),
        (1, {"type": "user_input_request", "questions": [
            {"id": "checks", "header": "Release checks",
             "question": "Which checks should block the 1.2 release?",
             "options": [
                 {"label": "Unit tests (Recommended)", "description": "pytest on Python 3.11 to 3.13."},
                 {"label": "Wheel smoke test (Recommended)",
                  "description": "Install the built wheel in a clean venv and run borealis --version."},
                 {"label": "Type check", "description": "mypy --strict on src/."},
                 {"label": "Docs build", "description": "mkdocs build with warnings as errors."}],
             "multiSelect": True}]}),
    ],
    "gh-issue-15": [
        (1, user("Implement issue #15: reject temperatures below absolute zero, with tests.",
                 by="agent")),
        (1, edit(f"{wt('sandbox', 'fix/absolute-zero')}/guards.py",
                 "@@ -0,0 +1,6 @@\n+from converter import ABSOLUTE_ZERO_C\n+\n+\n"
                 "+def check_celsius(value: float) -> float:\n+    if value < ABSOLUTE_ZERO_C:\n"
                 "+        raise ValueError(f\"{value} C is below absolute zero\")\n", 6, 0)),
        (1, cmd("/bin/bash -lc \"python3 -m unittest -v\"",
                "test_below_zero_raises ... ok\ntest_boundary_allowed ... ok\n\n"
                "Ran 5 tests in 0.002s\n\nOK\n")),
        (1, cmd("/bin/bash -lc \"gh pr create --fill --head fix/absolute-zero\"",
                "https://github.com/tannerpolley/t3code-sandbox/pull/24\n")),
        (1, say("Done. `check_celsius` rejects anything below −273.15 °C and allows the boundary, "
                "as agreed on the issue. PR #24 closes #15.")),
    ],
    "gh-orchestrator": [
        (1, user("Keep an eye on the t3code-sandbox issues. Repository work stays paused while we "
                 "test the Issues pane.")),
        (1, say("Understood. Repository work is **paused** and comment publishing is off, so I "
                "won't start workers or post to GitHub until you resume it.")),
        (2, user("Except #15: that bug blocks the parse work, so run it now in a worktree.")),
        (2, {"type": "subagent", "child": "gh-issue-15", "status": "completed",
             "prompt": "Implement issue #15 in a worktree and open a PR.",
             "result": "Opened PR #24, which closes #15."}),
    ],
    "gh-issue-6": [
        (1, user("Implement issue #6: add a `k_to_c` function with tests.", by="agent")),
        (1, think("A Kelvin to Celsius helper is one subtraction; the tests should cover 0 K and "
                  "273.15 K.")),
    ],
    "gh-issue-7": [
        (1, user("Implement issue #7: add `f_to_k` and `k_to_f` with tests.", by="agent")),
        (1, say("Both conversions are straightforward. One choice is yours before I write them.")),
        (1, {"type": "user_input_request", "questions": [
            {"id": "rounding", "header": "Rounding",
             "question": "Should f_to_k and k_to_f round their results?",
             "options": [{"label": "No rounding (Recommended)", "description": "Return exact floats."},
                         {"label": "Two decimals", "description": "Round to 0.01 for display."}],
             "multiSelect": False}]}),
    ],
}
TIMELINES["status-input"] = TIMELINES["cas-charting"]
TIMELINES["status-waiting"] = [(1, child_card("status-waiting-child", "Verify the release artifacts."))]

PROCESS_COMMANDS = {
    "proc-cpp": "make -j16 -C build/cpp",
    "proc-vite": "npm run dev -- --host 127.0.0.1 --port 5173",
    "proc-rust": "cargo build --manifest-path crates/solver/Cargo.toml",
    "proc-nested-tests": "pytest -n 8 tests/integration --cov=solver",
}
for key, command in PROCESS_COMMANDS.items():
    TIMELINES[key] = [(1, user(f"Run {command} and report progress.", by="agent")),
                      (1, bg(command, f"call_mock_{key}",
                             f"$ {command}\n[fixture] Running; sample output only.\n", claude=BY_KEY[key]["provider"] == C))]


def write_process_fixture():
    """The server resolves the root ppid at read time; no real processes are launched."""
    processes = []

    def add(command, parent="server", cpu=0.5, mib=12):
        pid = 900000 + len(processes)
        processes.append(dict(pid=pid, ppid=parent, command=command, cpuPercent=cpu,
                              residentBytes=int(mib * 1024 * 1024),
                              startTimeMs=int((NOW - timedelta(minutes=5)).timestamp() * 1000) + len(processes) * 30))
        return pid

    cpp = add("bash -c " + PROCESS_COMMANDS["proc-cpp"])
    make = add(PROCESS_COMMANDS["proc-cpp"], cpp, 1.2, 28)
    for n in range(16):
        cache = add(f"ccache c++ -O3 -c src/flux_{n:02}.cpp -o build/flux_{n:02}.o", make, 0.8, 18)
        compiler = add(f"c++ -O3 -c src/flux_{n:02}.cpp -o build/flux_{n:02}.o", cache, 1.4, 26)
        add(f"/usr/lib/gcc/x86_64-linux-gnu/14/cc1plus src/flux_{n:02}.cpp -O3", compiler, 48 + n, 220 + 8 * n)
    vite = add(PROCESS_COMMANDS["proc-vite"], cpu=0.4, mib=50)
    node = add("node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173", vite, 3.6, 174)
    add("node scripts/typecheck-watch.mjs --project web", node, 7.3, 260)
    for n in range(3):
        add(f"node_modules/@esbuild/linux-x64/bin/esbuild --service=0.25.0 --ping --worker={n}", node, 2.1 + n, 32 + n * 4)
    rust = add(PROCESS_COMMANDS["proc-rust"], cpu=1.8, mib=82)
    for n in range(12):
        add(f"rustc --crate-name solver_part_{n} crates/solver/src/part_{n}.rs --emit=metadata,link -C opt-level=3", rust, 32 + n * 2, 180 + n * 12)
    add("cc -o target/debug/build/solver build/solver.o", rust, 12, 44)
    tests = add(PROCESS_COMMANDS["proc-nested-tests"], cpu=2.2, mib=98)
    for n in range(8):
        add(f"python -u -c 'from execnet.gateway_base import serve; serve()' --pytest-xdist-worker=gw{n}", tests, 18 + n, 110 + n * 3)
    add("coverage combine --data-file=.coverage.integration", tests, 1.1, 24)
    bench = add("uv run python scripts/bench.py --cells 1000,10000,100000", cpu=0.2, mib=16)
    python = add("python scripts/bench.py --cells 1000,10000,100000", bench, 94, 1480)
    for n in range(4):
        add(f"python -m multiprocessing.spawn --worker={n} --campaign=10k", python, 65 + n, 340 + n * 20)
    add("tee results/bench-summary.log", bench, 0.1, 3)
    add("tail -f results/bench.log", cpu=0.1, mib=3)
    FIXTURE.mkdir(parents=True, exist_ok=True)
    (FIXTURE / "processes.json").write_text(json.dumps(processes, indent=2) + "\n")


FAILURES = {key: spec["failure"] for key, spec in BY_KEY.items() if "failure" in spec}


def native_ref(driver, seed):
    return {"driver": driver, "strength": "strong",
            "nativeId": seed if seed.startswith(("call_", "toolu_")) else
            (f"exec-{uid(seed)}" if driver == X else f"toolu_{uid(seed).replace('-', '')[:24]}")}


def claude_task_file(native):
    return FIXTURE / "tasks" / f"{native}.output"


def timeline_rows(spec):
    """Every row one thread's timeline needs, tagged base or live."""
    key, tid = spec["key"], thread_id(spec)
    entries = TIMELINES.get(key, [])
    rows = []
    for ordinal in sorted({n for n, _ in entries}):
        group = [raw for n, raw in entries if n == ordinal]
        start, end = run_window(spec, ordinal)
        run_live = ordinal > run_count(spec)
        for index, raw in enumerate(group):
            moment = start + (end - start) * (index + 1) / (len(group) + 1)
            item_id = f"turn-item:mock:{uid(f'{key}/{ordinal}/{index}')}"
            kind = raw["type"]
            status = raw.get("status", "waiting" if kind.endswith("_request") else
                             "failed" if kind == "error" else "completed")
            active = status in ("running", "waiting", "pending")
            on_root = kind in ("user_message", "assistant_message", "reasoning", "error",
                               "proposed_plan", "todo_list", "checkpoint")
            node = root_node(spec, ordinal) if on_root else f"node:mock:{uid(item_id)}"
            item = {
                "id": item_id, "threadId": tid, "runId": run_id(spec, ordinal), "nodeId": node,
                "providerThreadId": None, "providerTurnId": None,
                "nativeItemRef": None if on_root or kind.endswith("_request") or (
                    kind == "subagent" and not raw.get("native")) else
                native_ref(spec["provider"], raw.get("native") if isinstance(raw.get("native"), str)
                           else item_id),
                "parentItemId": None, "ordinal": ordinal * 1_000_000 + index + 1,
                "status": status, "title": raw.get("title"), "startedAt": iso(moment),
                "completedAt": None if active else iso(moment + timedelta(seconds=3)),
                "updatedAt": iso(moment), "type": kind,
            }
            extra = {}
            if kind == "user_message":
                agent = raw["by"] == "agent"
                extra = {"createdBy": "agent" if agent else "user",
                         "creationSource": "mcp" if agent else "web",
                         "messageId": user_message_id(spec, ordinal), "inputIntent": "turn_start",
                         "text": raw["text"], "attachments": []}
            elif kind == "assistant_message":
                extra = {"messageId": f"message:mock:{uid(item_id)}", "text": raw["text"],
                         "streaming": False}
            elif kind == "reasoning":
                extra = {"text": raw["text"], "streaming": False}
            elif kind == "command_execution":
                native = item["nativeItemRef"]["nativeId"]
                output = raw.get("output")
                if raw.get("claude"):
                    output = (f"Command running in background with ID: {native}. Output is being "
                              f"written to: {claude_task_file(native)}")
                extra = {"input": raw["input"], **({"output": output} if output is not None else {}),
                         **({"exitCode": raw["exitCode"]} if "exitCode" in raw else {})}
            elif kind == "file_change":
                extra = {k: raw[k] for k in ("fileName", "diffStr", "additions", "deletions")}
            elif kind == "dynamic_tool":
                extra = {"toolName": raw["toolName"], "input": raw["input"], "output": raw["output"],
                         **({"toolSource": {"key": f"mcp:{raw['source']}", "name": raw["source"],
                                            "kind": "integration"}} if raw.get("source") else {})}
            elif kind == "web_search":
                extra = {"patterns": raw["patterns"], "results": raw["results"]}
            elif kind == "todo_list" or kind == "proposed_plan":
                plan_id = f"plan:mock:{uid(item_id)}"
                if kind == "todo_list":
                    steps = [{"id": f"step-{n}", "text": text, "status": state}
                             for n, (text, state) in enumerate(raw["steps"], 1)]
                    extra = {"planId": plan_id, "steps": steps, "explanation": raw["explanation"]}
                    plan = {"steps": steps, "explanation": raw["explanation"]}
                else:
                    extra = {"planId": plan_id, "markdown": raw["markdown"], "streaming": False}
                    plan = {"markdown": raw["markdown"]}
                rows.append(("plan", run_live, (plan_id, tid, run_id(spec, ordinal), node, kind,
                    "active", json.dumps({"id": plan_id, "threadId": tid, "runId": run_id(spec, ordinal),
                                          "nodeId": node, "status": "active", "kind": kind, **plan}))))
            elif kind == "subagent":
                child = BY_KEY.get(raw.get("child"))
                driver = child["provider"] if child else spec["provider"]
                extra = {"subagentId": node, "origin": "provider_native" if raw.get("native") else "app_owned",
                         "driver": driver, "providerInstanceId": driver,
                         "childThreadId": thread_id(child) if child else None,
                         "prompt": raw["prompt"], "result": raw.get("result")}
                item["title"] = raw.get("title") or (child["title"] if child else None)
            elif kind == "checkpoint":
                scope = checkpoint_scope_id(spec)
                extra = {"checkpointId": checkpoint_id(scope, ordinal), "scopeId": scope,
                         "files": checkpoint_files()}
            elif kind == "error":
                failure = FAILURES[key]
                extra = {"failure": {k: failure[k] for k in ("class", "message", "code", "retryable")
                                     if k in failure} | ({"resetAt": failure["resetAt"]}
                                                         if "resetAt" in failure else {})}
            elif kind in ("user_input_request", "approval_request"):
                request_id = f"runtime-request:mock:{uid(item_id)}"
                question = kind == "user_input_request"
                extra = {"requestId": request_id}
                if question:
                    extra |= {"questions": raw["questions"], "responseMode": "message"}
                else:
                    extra |= {"requestKind": raw["requestKind"], "prompt": raw["prompt"],
                              "options": [{"decision": "accept", "label": "Run once"},
                                          {"decision": "acceptForSession", "label": "Allow for this session"},
                                          {"decision": "decline", "label": "Decline"}]}
                # A question answered by message survives restarts; an approval needs the live
                # provider session, so recovery expires it and `live` writes it again.
                capability = ({"type": "message"} if question else
                              {"type": "live", "providerSessionId": f"provider-session:mock:{uid(tid)}"})
                request = {"id": request_id, "nodeId": node, "providerTurnId": None,
                           "nativeRequestRef": {"driver": spec["provider"], "strength": "strong",
                                                "nativeId": f"async:call_{uid(request_id).replace('-', '')[:20]}"},
                           "kind": "user_input" if question else raw["requestKind"],
                           "status": "pending", "responseCapability": capability,
                           "createdAt": iso(moment), "resolvedAt": None}
                rows.append(("request", run_live or not question,
                             (request_id, tid, node, None, request["kind"], "pending", iso(moment),
                              None, json.dumps(request))))
            item |= extra
            live = run_live or raw.get("live", False) or kind == "approval_request"
            rows.append(("item", live, (item_id, tid, item["runId"], node, None, None, None,
                                        item["ordinal"], kind, status, item["updatedAt"],
                                        json.dumps(item))))
            rows.append(("position", live, (tid, item_id, item["ordinal"])))
            if kind in ("user_message", "assistant_message"):
                rows.append(("message", live, (extra["messageId"], tid, item["runId"], node,
                             "user" if kind == "user_message" else "assistant", 0, item["startedAt"],
                             item["updatedAt"], json.dumps({
                                 **({"createdBy": extra["createdBy"], "creationSource": extra["creationSource"]}
                                    if kind == "user_message" else
                                    {"createdBy": "agent", "creationSource": "provider"}),
                                 "id": extra["messageId"], "threadId": tid, "runId": item["runId"],
                                 "nodeId": node, "role": "user" if kind == "user_message" else "assistant",
                                 "text": raw["text"], "attachments": [], "streaming": False,
                                 "createdAt": item["startedAt"], "updatedAt": item["updatedAt"]}))))
            if raw.get("shell"):
                # The fork's inline shell runs key a code block by message id and its offset.
                block_id = f"{extra['messageId']}:{raw['text'].index('```bash')}"
                command = raw["text"].split("```bash\n", 1)[1].split("```", 1)[0].strip()
                record = {"threadId": tid, "runId": f"mock-{uid(block_id)[:8]}", "blockId": block_id,
                          "command": command, "language": "bash", "terminalId": "inline-shell-mock",
                          "sequence": 0, "error": None, "status": "completed",
                          "startedAt": iso(moment - timedelta(minutes=2)),
                          "completedAt": iso(moment - timedelta(minutes=2) + timedelta(seconds=2)),
                          "exitCode": 0, "durationMs": 1840, "output": raw["shell"]["output"]}
                rows.append(("shell", live, (tid, block_id, record["runId"], "completed", json.dumps(record))))
            if raw.get("log"):
                native = item["nativeItemRef"]["nativeId"]
                path = (claude_task_file(native) if raw.get("claude") else
                        USERDATA / "logs" / "background-tasks" / f"{b64(tid)}.{b64(native)}.output")
                rows.append(("file", True, (path, raw["log"])))
    return rows


SQL = {
    "item": "INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(turn_item_id) DO UPDATE SET status = excluded.status, "
            "updated_at = excluded.updated_at, payload_json = excluded.payload_json",
    "position": "INSERT OR IGNORE INTO orchestration_v2_turn_item_positions VALUES (?, ?, ?)",
    "message": "INSERT OR REPLACE INTO orchestration_v2_projection_messages (message_id, thread_id, "
               "run_id, node_id, role, streaming, created_at, updated_at, payload_json) "
               "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    "plan": "INSERT OR REPLACE INTO orchestration_v2_projection_plans VALUES (?, ?, ?, ?, ?, ?, ?)",
    "request": "INSERT OR REPLACE INTO orchestration_v2_projection_runtime_requests VALUES "
               "(?, ?, ?, ?, ?, ?, ?, ?, ?)",
    "shell": "INSERT OR IGNORE INTO inline_shell_runs (thread_id, block_id, run_id, status, record_json) "
             "VALUES (?, ?, ?, ?, ?)",
}
RUN_SQL = ("INSERT OR REPLACE INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, "
           "provider, provider_thread_id, status, requested_at, completed_at, payload_json, "
           "provider_instance_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")


def write_timelines(db, phase_live):
    for spec in THREADS:
        for table, live, values in timeline_rows(spec):
            if live != phase_live:
                continue
            if table == "file":
                path, text = values
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            else:
                db.execute(SQL[table], values)


def checkpoint_scope_id(spec):
    return f"checkpoint-scope:thread:{enc(thread_id(spec))}:name:root"


def checkpoint_id(scope, ordinal):
    return f"checkpoint:scope:{enc(scope)}:name:{ordinal}"


def checkpoint_ref(scope, ordinal):
    """Mirrors CheckpointService.checkpointRefForScopeOrdinal."""
    key = hashlib.sha256(scope.encode()).hexdigest()[:32]
    return f"refs/t3/orchestration-v2/checkpoints/{b64(key)}/ordinal/{ordinal}"


def checkpoint_files():
    return [{"path": path, "kind": "modified", "additions": adds, "deletions": dels}
            for path in LOGIN_FILES for _, adds, dels in [file_diff(path)]]


def git(cwd, *args, stdin=None, env=None):
    return subprocess.run(
        ["git", "-C", cwd, *args], input=stdin, capture_output=True, text=True, check=True,
        env={**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_AUTHOR_NAME": "T3 Dev Mock",
             "GIT_AUTHOR_EMAIL": "mock@t3-dev-mock.invalid", "GIT_COMMITTER_NAME": "T3 Dev Mock",
             "GIT_COMMITTER_EMAIL": "mock@t3-dev-mock.invalid", **(env or {})},
    ).stdout.strip()


def snapshot(cwd, parent, files):
    """A commit of `parent` plus `files`, outside any branch, like a checkpoint capture."""
    with tempfile.TemporaryDirectory() as tmp:
        env = {"GIT_INDEX_FILE": f"{tmp}/index"}
        git(cwd, "read-tree", parent, env=env)
        for path, text in files.items():
            blob = git(cwd, "hash-object", "-w", "--stdin", stdin=text)
            git(cwd, "update-index", "--add", "--cacheinfo", f"100644,{blob},{path}", env=env)
        tree = git(cwd, "write-tree", env=env)
        return git(cwd, "commit-tree", tree, "-p", parent, "-m", "checkpoint", env=env)


def write_checkpoints(db):
    """Turn 1 of the login thread: a baseline and an after snapshot the Diff panel compares."""
    spec = BY_KEY["aur-login-timeout"]
    tid, scope, root = thread_id(spec), checkpoint_scope_id(spec), root_node(spec, 1)
    start, end = run_window(spec, 1)
    before = snapshot(AURORA_LOGIN, git(AURORA_LOGIN, "rev-parse", "HEAD"),
                      {path: old for path, (old, _) in LOGIN_FILES.items()})
    after = snapshot(AURORA_LOGIN, before, {path: new for path, (_, new) in LOGIN_FILES.items()})
    db.execute("INSERT INTO orchestration_v2_projection_checkpoint_scopes VALUES "
               "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
               (scope, tid, run_id(spec, 1), root, None, None, "root_run", 0, 1, iso(start),
                json.dumps({"id": scope, "threadId": tid, "runId": run_id(spec, 1), "nodeId": root,
                            "parentScopeId": None, "providerThreadId": None, "kind": "root_run",
                            "ordinalWithinParent": 0, "advancesAppRunCount": True,
                            "cwd": AURORA_LOGIN, "createdAt": iso(start)})))
    for ordinal, commit, captured in ((0, before, start), (1, after, end)):
        ref = checkpoint_ref(scope, ordinal)
        git(AURORA_LOGIN, "update-ref", ref, commit)
        payload = {"id": checkpoint_id(scope, ordinal), "threadId": tid, "scopeId": scope,
                   "runId": run_id(spec, 1) if ordinal else None, "nodeId": root,
                   "parentCheckpointId": checkpoint_id(scope, 0) if ordinal else None,
                   "ordinalWithinScope": ordinal, "appRunOrdinal": ordinal or None, "ref": ref,
                   "status": "ready", "files": checkpoint_files() if ordinal else [],
                   "capturedAt": iso(captured)}
        db.execute("INSERT INTO orchestration_v2_projection_checkpoints VALUES "
                   "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (payload["id"], tid, scope, payload["runId"], root, payload["parentCheckpointId"],
                    ordinal, payload["appRunOrdinal"], "ready", iso(captured), json.dumps(payload)))


def sidebar_layout():
    showcases, folders, nested, inbox = (uid(f"section/{name}") for name in
                                         ("showcases", "folders", "nested", "inbox"))
    return {
        "sidebarProjectSections": [
            {"id": showcases, "name": "Feature showcases", "projectKeys":
             [PID[key] for key in ("processes", "families", "roles", "statuses", "badges", "workflow")],
             "collapsed": False, "color": "teal", "folderIcons": True},
            {"id": folders, "name": "Folder sections", "projectKeys": [], "collapsed": False,
             "folderIcons": True},
            {"id": nested, "name": "Plain folders", "projectKeys": [PID["sections"]],
             "collapsed": False, "parentId": folders, "folderIcons": True},
            {"id": inbox, "name": "INBOX", "projectKeys": [], "collapsed": False},
        ],
        "projectExpandedById": {pid: True for pid in PID.values()},
        "projectOrder": list(PID.values()),
        "sidebarOtherProjectsExpanded": True,
    }


def base(db):
    db.executemany(
        "INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, "
        "created_at, updated_at, deleted_at, auto_pull) VALUES (?, ?, ?, '[]', ?, ?, NULL, 0)",
        [(PID[key], title, str(ROOT / rel), at(days=30), at(days=30))
         for key, (title, rel) in PROJECTS.items()],
    )
    db.executemany(
        "INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, "
        "default_provider, runtime_mode, interaction_mode, active_provider_thread_id, created_at, "
        "updated_at, archived_at, deleted_at, payload_json, provider_instance_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [thread_row(spec) for spec in THREADS],
    )
    db.executemany(RUN_SQL, [row for spec in THREADS for row in finished_runs(spec)])
    write_timelines(db, phase_live=False)
    write_checkpoints(db)
    db.executemany(
        "INSERT INTO issue_thread_links (host, repository, issue_number, thread_id) VALUES (?, ?, ?, ?)",
        [("github.com", SANDBOX_REPO.lower(), spec["gh_issue"], thread_id(spec))
         for spec in THREADS if "gh_issue" in spec],
    )
    owner = repository_orchestration()
    db.execute(
        "INSERT INTO orchestration_v2_projection_repository_orchestration VALUES "
        "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (owner["host"], owner["repositoryId"], owner["repository"],
         thread_id(BY_KEY["gh-orchestrator"]), owner["projectId"], "worktree",
         owner["launchCommandId"], owner["revision"], 1, owner["workerLimit"], 0, 0,
         at(hours=2), at(hours=2)),
    )
    db.execute(
        "INSERT OR REPLACE INTO sidebar_layout (id, revision, legacy_imported_at, legacy_import_id, "
        "layout_json) VALUES (1, 1, ?, NULL, ?)",
        (at(), json.dumps(sidebar_layout())),
    )
    # New worktrees from the UI land in <repo>/.worktrees, like the seeded ones.
    settings_path = USERDATA / "settings.json"
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    settings.update(worktreesDirectory="project-local", addProjectBaseDirectory=str(ROOT))
    settings_path.write_text(json.dumps(settings, indent=2) + "\n")


def live(db):
    write_process_fixture()
    db.executemany(RUN_SQL, [run_row(spec, live_ordinal(spec), "running")
                             for spec in THREADS if "live" in spec and spec["kind"] != "native"])
    db.executemany(
        "INSERT OR REPLACE INTO orchestration_v2_projection_subagents (subagent_id, thread_id, "
        "run_id, parent_node_id, provider, provider_thread_id, child_thread_id, origin, status, "
        "started_at, completed_at, updated_at, payload_json, driver, provider_instance_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [native_subagent_row(spec) for spec in THREADS if spec["kind"] == "native"],
    )
    write_timelines(db, phase_live=True)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode not in ("base", "live"):
        sys.exit("usage: seed.py base|live")
    if DB.resolve() == LIVE_DB.resolve():
        sys.exit("refusing to write the live T3 database")
    if not DB.exists():
        sys.exit(f"{DB} is missing; start t3-dev once so migrations create it")
    db = sqlite3.connect(DB, timeout=10)
    with db:
        (base if mode == "base" else live)(db)
    db.close()
    print(f"seed.py {mode}: done ({len(THREADS)} threads defined)")


if __name__ == "__main__":
    main()
