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
    "aurora": ("aurora-web", "Apps/aurora-web"),
    "borealis": ("borealis-cli", "Apps/borealis-cli"),
    "cascade": ("cascade-sim", "Research/cascade-sim"),
    "delta": ("delta-notes", "Research/delta-notes"),
    "echo": ("echo-playground", "Scratch/echo-playground"),
    # A real private test repository (cloned by seed.sh), so the Issues pane has GitHub data.
    "sandbox": ("t3code-sandbox", "GitHub/t3code-sandbox"),
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

# kind: top (user thread), child (app-owned delegate_task child), native (provider subagent).
# runs: finished (started, completed) as timedelta kwargs; `failure` fails the last one.
# live: minutes ago the live run (or native task) began; it is written by `seed.py live`.
# visited before the last completion shows Done; after it, idle. settled, snoozed, pinned and
# archived park the row the way the sidebar actions do.
THREADS = [
    dict(key="aur-orchestrate", project="aurora", kind="top", role="orchestrator",
         title="Coordinate the sidebar gradient redesign", provider=C, model="claude-opus-5-5",
         effort="xhigh", created=dict(days=30), runs=[(dict(hours=3), dict(hours=2, minutes=40))],
         visited=dict(minutes=39), live=38,
         prs=[pr("aurora-web", number, "merged", f"Sidebar refinement {number}",
                 f"sidebar/refinement-{number}", checks="passing", review="approved")
              for number in range(100, 223)]),
    dict(key="aur-gradient-header", project="aurora", kind="child", parent="aur-orchestrate",
         role="implementor", title="Build the gradient header component", provider=X,
         model="gpt-6.1-sol", effort="high", branch="feature/sidebar-gradient",
         worktree=wt("aurora", "feature/sidebar-gradient"), created=dict(minutes=36), live=35),
    # Native subagents carry the role their provider agent type maps to (threadRole.ts):
    # Codex "explorer" and Claude "Explore" are Investigators, "worker" and
    # "general-purpose" Implementors.
    dict(key="aur-theme-scan", project="aurora", kind="native", parent="aur-gradient-header",
         role="investigator",
         title="/root/theme_token_scan", provider=X, model="gpt-6-luna", effort="max",
         branch="feature/sidebar-gradient", worktree=wt("aurora", "feature/sidebar-gradient"),
         created=dict(minutes=20), live=20),
    dict(key="aur-contrast", project="aurora", kind="child", parent="aur-orchestrate",
         role="investigator",
         title="Collect contrast ratios for the new palette", provider=C,
         model="claude-sonnet-5-5", effort="low", created=dict(minutes=14), live=14),
    dict(key="aur-css-explore", project="aurora", kind="native", parent="aur-orchestrate",
         role="investigator",
         title="Explore existing sidebar CSS variables", provider=C, model="claude-sonnet-5-5",
         effort="medium", created=dict(minutes=31), live=31),
    dict(key="aur-review", project="aurora", kind="child", parent="aur-orchestrate",
         role="reviewer", title="Review the gradient header changes", provider=X,
         model="gpt-6.1-sol", effort="high", created=dict(minutes=18), live=17),
    dict(key="aur-login-timeout", project="aurora", kind="top", role="implementor",
         title="Fix login timeout on slow networks", provider=X, model="gpt-6.1-sol",
         effort="medium", branch="fix/login-timeout", worktree=wt("aurora", "fix/login-timeout"),
         created=dict(hours=1), runs=[(dict(minutes=58), dict(minutes=25))],
         visited=dict(minutes=59),
         prs=[pr("aurora-web", 12, "open", "Raise the login timeout and retry once",
                 "fix/login-timeout", checks="passing", review="review-required", diff=(18, 4, 2))]),
    dict(key="aur-browser-check", project="aurora", kind="child", parent="aur-orchestrate", role="checker",
         title="Check the release build in Safari and Firefox", provider=C,
         model="claude-haiku-5-5", effort="low", branch="release/1.2",
         created=dict(days=1, hours=4), runs=[(dict(days=1, hours=4), dict(days=1, hours=3, minutes=40))],
         visited=dict(days=1, hours=2), live=10),
    dict(key="aur-vite7", project="aurora", kind="child", parent="aur-orchestrate", role="implementor", title="Upgrade aurora-web to Vite 7",
         provider=X, model="gpt-6-luna", effort="low", branch="chore/vite-7", worktree=wt("aurora", "chore/vite-7"), created=dict(days=9),
         runs=[(dict(days=9), dict(days=8, hours=23, minutes=40))], visited=dict(days=8, hours=23),
         settled=dict(days=6),
         prs=[pr("aurora-web", 9, "merged", "Upgrade to Vite 7", "chore/vite-7", checks="passing",
                 review="approved", diff=(64, 51, 7))]),
    dict(key="aur-theme-layers", project="aurora", kind="child", parent="aur-orchestrate", role="implementor",
         title="Refactor theme tokens into CSS layers", provider=C, model="claude-opus-5-5",
         effort="xhigh", branch="refactor/theme-layers", worktree=wt("aurora", "refactor/theme-layers"), created=dict(hours=1, minutes=35),
         runs=[(dict(hours=1, minutes=30), dict(hours=1, minutes=20))], visited=dict(hours=1),
         failure={"class": "usage_limit", "message": "Claude usage limit reached. Your limit resets in about 3 hours.",
                  "code": "rate_limit_error", "retryable": True, "resetAt": LIMIT_RESET}),
    dict(key="aur-e2e-flake", project="aurora", kind="child", parent="aur-orchestrate", role="implementor",
         title="Revisit the flaky e2e test after the CI upgrade", provider=X, model="gpt-6.1-sol",
         effort="low", branch="fix/e2e-flake", worktree=wt("aurora", "fix/e2e-flake"), created=dict(days=1, hours=2), runs=[(dict(days=1, hours=2), dict(days=1, hours=1))],
         visited=dict(days=1), snoozed=(dict(hours=-18), dict(hours=2))),
    dict(key="aur-roadmap", project="aurora", kind="child", parent="aur-orchestrate", role="investigator", title="Roadmap: aurora-web 2.0",
         provider=C, model="claude-sonnet-5-5", effort="medium", created=dict(days=2),
         runs=[(dict(hours=5), dict(hours=4, minutes=50))], visited=dict(hours=4), pinned=True),
    dict(key="aur-canvas-spike", project="aurora", kind="child", parent="aur-orchestrate", role="implementor",
         title="Spike: canvas renderer for the sidebar", provider=X, model="gpt-6-luna",
         effort="medium", branch="experiment/canvas", worktree=wt("aurora", "experiment/canvas"), created=dict(days=6), runs=[(dict(days=6), dict(days=5, hours=23))],
         visited=dict(days=5), archived=dict(days=4)),
    dict(key="bor-orchestrate", project="borealis", kind="top", role="orchestrator",
         title="Coordinate borealis 1.2", provider=C, model="claude-opus-5-5", effort="high",
         created=dict(days=30), runs=[(dict(hours=2), dict(hours=1, minutes=55))]),
    dict(key="bor-packaging", project="borealis", kind="child", parent="bor-orchestrate", role="investigator",
         title="Investigate flaky packaging on release/1.2", provider=X, model="gpt-6-astra",
         effort="high", branch="release/1.2", created=dict(hours=1, minutes=10),
         runs=[(dict(minutes=55), dict(minutes=21))], visited=dict(minutes=18)),
    dict(key="bor-wheel-check", project="borealis", kind="child", parent="bor-packaging",
         role="checker", title="Verify wheel metadata on release/1.2", provider=C,
         model="claude-sonnet-5-5", effort="medium", branch="release/1.2",
         created=dict(minutes=21), live=20),
    dict(key="bor-json-status", project="borealis", kind="child", parent="bor-orchestrate", role="implementor",
         title="Add --json output to borealis status", provider=C, model="claude-opus-5-5",
         effort="medium", branch="feature/json-status", worktree=wt("borealis", "feature/json-status"), created=dict(days=2, hours=1), runs=[(dict(days=2, hours=1), dict(days=2))],
         visited=dict(days=1, hours=23), live=8),
    dict(key="bor-toml", project="borealis", kind="child", parent="bor-orchestrate", role="implementor",
         title="Port the config loader to TOML", provider=X, model="gpt-6.1-sol", effort="medium",
         branch="refactor/toml", worktree=wt("borealis", "refactor/toml"), created=dict(days=15), runs=[(dict(days=15), dict(days=14, hours=22))],
         visited=dict(days=14, hours=21), settled=dict(days=12)),
    dict(key="bor-stale-branches", project="borealis", kind="child", parent="bor-orchestrate", role="implementor",
         title="Clean up stale release branches", provider=X, model="gpt-6.1-sol",
         effort="medium", branch="chore/stale-branches", worktree=wt("borealis", "chore/stale-branches"), created=dict(minutes=13), live=12),
    # A Codex thread waiting on a multi-select question from T3's question tool.
    dict(key="bor-release-checks", project="borealis", kind="child", parent="bor-orchestrate", role="checker",
         title="Choose the release checks for borealis 1.2", provider=X, model="gpt-6.1-sol",
         effort="medium", branch="release/1.2", created=dict(minutes=50),
         runs=[(dict(minutes=48), dict(minutes=44))], visited=dict(minutes=45)),
    dict(key="bor-plugin-plan", project="borealis", kind="top", role="investigator", plan=True,
         title="Plan the borealis plugin API", provider=C, model="claude-opus-5-5", effort="high",
         created=dict(hours=3), runs=[(dict(hours=3), dict(hours=2, minutes=45))],
         visited=dict(hours=2, minutes=40)),
    dict(key="cas-fast-solver", project="cascade", kind="child", parent="cas-campaign", role="implementor",
         title="Speed up the fast solver on 10k-cell grids", provider=X, model="gpt-6.1-sol",
         effort="xhigh", branch="experiment/fast-solver",
         worktree=wt("cascade", "experiment/fast-solver"), created=dict(hours=6), live=13,
         runs=[(dict(hours=5), dict(hours=2))], visited=dict(hours=5, minutes=10),
         prs=[pr("cascade-sim", 4, "open", "Vectorize the fast solver's inner loop",
                 "experiment/fast-solver", draft=True, checks="failing", mergeable="conflicting",
                 diff=(212, 97, 6))]),
    dict(key="cas-convergence", project="cascade", kind="child", parent="cas-campaign", role="reviewer",
         title="Review solver convergence plots", provider=C, model="claude-opus-5-5",
         effort="max", created=dict(days=1, hours=2), runs=[(dict(days=1, hours=2), dict(days=1, hours=1))],
         visited=dict(days=1)),
    dict(key="cas-boundary", project="cascade", kind="top", role="investigator", title=LONG_TITLE, provider=C,
         model="claude-opus-5-5", effort="high", created=dict(days=20),
         runs=[(dict(days=20), dict(days=19, hours=23))], visited=dict(days=19, hours=22),
         settled=dict(days=17)),
    dict(key="cas-charting", project="cascade", kind="child", parent="cas-campaign", role="investigator",
         title="Choose a charting library for cascade-sim", provider=C, model="claude-opus-5-5",
         effort="high", created=dict(minutes=42), runs=[(dict(minutes=40), dict(minutes=33))],
         visited=dict(minutes=30)),
    # One repository coordinator, with direct workers and a nested profiler.
    dict(key="cas-campaign", project="cascade", kind="top", role="orchestrator",
         title="Run the 10k-cell solver benchmark campaign", provider=X, model="gpt-6.1-sol",
         effort="high", created=dict(days=30), live=26),
    dict(key="cas-numba", project="cascade", kind="child", parent="cas-campaign",
         role="implementor", title="Port the solver kernel to Numba", provider=C,
         model="claude-opus-5-5", effort="high", branch="experiment/numba-kernel",
         worktree=wt("cascade", "experiment/numba-kernel"), created=dict(minutes=23), live=22),
    dict(key="cas-hot-loop", project="cascade", kind="native", parent="cas-numba", role="investigator",
         title="Profile the hot loop in flux_update", provider=C, model="claude-sonnet-5-5",
         effort="medium", branch="experiment/numba-kernel",
         worktree=wt("cascade", "experiment/numba-kernel"), created=dict(minutes=15), live=15),
    dict(key="cas-bench", project="cascade", kind="child", parent="cas-campaign",
         role="checker",
         title="Benchmark 1k, 10k and 100k grids", provider=C, model="claude-sonnet-5-5",
         effort="medium", created=dict(minutes=25), runs=[(dict(minutes=24), dict(minutes=12))]),
    dict(key="cas-harness-review", project="cascade", kind="child", parent="cas-campaign",
         role="reviewer", title="Review the benchmark harness", provider=X, model="gpt-6-astra",
         effort="xhigh", created=dict(minutes=19), live=18),
    dict(key="cas-plot-style", project="cascade", kind="child", parent="cas-campaign",
         role="investigator", title="Pick plot styling for the report", provider=C,
         model="claude-haiku-5-5", effort="low", created=dict(minutes=21),
         runs=[(dict(minutes=20), dict(minutes=9))]),
    dict(key="cas-timings", project="cascade", kind="native", parent="cas-campaign", role="investigator",
         title="/root/collect_timings", provider=X, model="gpt-6-luna", effort="medium",
         created=dict(minutes=11), live=11),
    # The Issues pane's repository orchestrator, paused with publishing off (see base()), and
    # two issue workers whose live work turns #6 and #7 blue.
    dict(key="gh-orchestrator", project="sandbox", kind="top", role="orchestrator",
         title="Coordinate t3code-sandbox issues", provider=C, model="claude-opus-5-5",
         effort="high", created=dict(hours=2),
         runs=[(dict(hours=2), dict(hours=1, minutes=50)), (dict(hours=1, minutes=42), dict(hours=1, minutes=8))],
         visited=dict(hours=1, minutes=5), orchestrates=True),
    dict(key="gh-issue-6", project="sandbox", kind="child", parent="gh-orchestrator",
         role="implementor", gh_issue=6, provider=X, model="gpt-6.1-sol", effort="medium",
         branch="t3/issue-6-k-to-c", worktree=wt("sandbox", "t3/issue-6-k-to-c"), created=dict(minutes=17), live=16),
    dict(key="gh-issue-7", project="sandbox", kind="child", parent="gh-orchestrator",
         role="implementor", gh_issue=7, provider=C, model="claude-sonnet-5-5", effort="medium",
         branch="t3/issue-7-f-to-k", worktree=wt("sandbox", "t3/issue-7-f-to-k"), created=dict(minutes=34), runs=[(dict(minutes=33), dict(minutes=14))]),
    # A finished issue worker in its own worktree, with the real open PR #24 that closes #15.
    dict(key="gh-issue-15", project="sandbox", kind="child", parent="gh-orchestrator",
         role="implementor", gh_issue=15, provider=X, model="gpt-6.1-sol", effort="high",
         branch="fix/absolute-zero", worktree=wt("sandbox", "fix/absolute-zero"),
         created=dict(hours=1, minutes=40), runs=[(dict(hours=1, minutes=38), dict(hours=1, minutes=10))],
         prs=[pr("t3code-sandbox", 24, "open", "Reject temperatures below absolute zero",
                 "fix/absolute-zero", owner="tannerpolley", review="review-required",
                 diff=(6, 0, 1))]),
    dict(key="del-orchestrate", project="delta", kind="top", role="orchestrator", branch=None,
         title="Coordinate turbulence research notes", provider=C, model="claude-opus-5-5",
         effort="high", created=dict(days=30), runs=[(dict(hours=4), dict(hours=3, minutes=40))]),
    dict(key="del-closures", project="delta", kind="child", parent="del-orchestrate", role="investigator", branch=None,
         title="Summarize reading notes on turbulence closures", provider=C,
         model="claude-sonnet-5-5", effort="high", created=dict(hours=3, minutes=20),
         runs=[(dict(hours=3, minutes=20), dict(hours=3))], visited=dict(hours=2, minutes=50), live=3),
    dict(key="del-weekly-log", project="delta", kind="top", role="investigator", branch=None,
         title="Draft the weekly research log", provider=X, model="gpt-6-luna", effort="medium",
         created=dict(days=12), runs=[(dict(days=12), dict(days=11, hours=23, minutes=50))],
         visited=dict(days=11, hours=23), settled=dict(days=8)),
    dict(key="ech-orchestrate", project="echo", kind="top", role="orchestrator",
         title="Coordinate playground experiments", provider=X, model="gpt-6.1-sol",
         effort="high", created=dict(days=30), runs=[(dict(minutes=10), dict(minutes=9))]),
    dict(key="ech-pattern-matching", project="echo", kind="child", parent="ech-orchestrate", role="implementor",
         title="Try the new pattern-matching syntax", provider=X, model="gpt-6-luna",
         effort="low", branch="experiment/pattern-matching", worktree=wt("echo", "experiment/pattern-matching"), created=dict(minutes=6), live=5),
    dict(key="ech-json-parsers", project="echo", kind="child", parent="ech-orchestrate", role="checker",
         title="Benchmark three JSON parsers", provider=C, model="claude-haiku-5-5",
         effort="medium", created=dict(days=1, hours=6),
         runs=[(dict(days=1, hours=6), dict(days=1, hours=5, minutes=30))],
         visited=dict(days=1, hours=6)),
    dict(key="ech-ci-matrix", project="echo", kind="top", role="implementor",
         title="Migrate CI to a GitHub Actions matrix", provider=X, model="gpt-6-luna",
         effort="high", branch="ci/matrix", worktree=wt("echo", "ci/matrix"), created=dict(hours=2), runs=[(dict(hours=2), dict(hours=1, minutes=50))],
         visited=dict(hours=1, minutes=40),
         failure={"class": "provider_error",
                  "message": "The model stream ended before the turn completed.",
                  "code": "responseStreamDisconnected", "retryable": True},
         prs=[pr("echo-playground", 3, "closed", "Try a CI matrix", "ci/matrix", checks="failing",
                 diff=(31, 8, 1))]),
    dict(key="ech-readme-badges", project="echo", kind="child", parent="ech-orchestrate", role="implementor", title="Tidy the README badges",
         provider=C, model="claude-haiku-5-5", effort="low", branch="docs/badges", worktree=wt("echo", "docs/badges"), created=dict(days=1, hours=5),
         runs=[(dict(days=1, hours=5), dict(days=1, hours=4, minutes=55))],
         visited=dict(days=1, hours=4), snoozed=(dict(hours=2), dict(days=1, hours=4))),
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
        spec["title"] = f"#{spec['gh_issue']} {spec['linked_issue']['title']}"
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


AURORA_LOGIN = wt("aurora", "fix/login-timeout")
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

The dev server is still running on port 5173 if you want to try it in the browser. I opened [#12](https://github.com/t3-dev-mock/aurora-web/pull/12) for review."""
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
        (1, bg("npm run dev -- --port 5173", "call_mockdevserver5173",
               "\n> aurora-web@1.1.1 dev\n> vite --port 5173\n\n  VITE v7.1.4  ready in 412 ms\n\n"
               "  ➜  Local:   http://127.0.0.1:5173/\n  ➜  Network: use --host to expose\n\n"
               "[vite] hmr update /src/login.ts\n[vite] hmr update /src/http.ts\n")),
        (1, cmd("/bin/bash -lc \"gh pr create --title 'Raise the login timeout and retry once' --fill\"",
                "https://github.com/t3-dev-mock/aurora-web/pull/12\n")),
        (1, say(LOGIN_SUMMARY, shell={"output": " ✓ src/login.test.ts (4 tests) 41ms\n\n"
                                               " Test Files  1 passed (1)\n      Tests  4 passed (4)\n"})),
        (1, {"type": "checkpoint"}),
    ],
    "aur-orchestrate": [
        (1, user("Coordinate the sidebar gradient redesign: split it into a header component, a "
                 "contrast pass and a CSS audit. Delegate, then review what comes back.")),
        (1, {"type": "subagent", "native": True, "title": "Inventory the design tokens",
             "prompt": "List every color token the sidebar uses and flag unused ones.",
             "result": "Found 14 color tokens; `--sidebar-accent-2`, `--nav-muted` and "
                       "`--legacy-blue` are unused.", "status": "completed"}),
        (1, say("The audit is done: 3 of 14 tokens are unused. Next I'll delegate the header to an "
                "Implementor in its own worktree and the contrast pass to a quick Claude child.")),
        (2, user("Go ahead and start the delegations.")),
        # Claude's task list (TaskCreate/TaskUpdate), on the live run.
        (2, {"type": "todo_list", "explanation": "Three delegations; I review each result before "
             "anything merges.", "steps": [
                 ("Audit the existing sidebar CSS variables", "completed"),
                 ("Build the gradient header component", "running"),
                 ("Check contrast ratios against WCAG AA", "running"),
                 ("Review and merge the header PR", "pending")]}),
        (2, {"type": "dynamic_tool", "toolName": "mcp__t3-code__delegate_task",
             "title": "delegate task", "source": "t3-code",
             "input": {"title": "Build the gradient header component", "role": "implementor",
                       "workspace": "worktree", "branch": "feature/sidebar-gradient"},
             "output": {"status": "started", "role": "implementor"}}),
        (2, child_card("aur-gradient-header", "Build the gradient header from the audited tokens; "
                       "add a visual test.", live=True)),
        (2, child_card("aur-contrast", "Compute contrast ratios for the new palette against both "
                       "themes.", live=True)),
    ],
    "bor-packaging": [
        (1, user("release/1.2 wheels fail to install on about one CI run in five. Find out why.")),
        (1, {"type": "web_search", "patterns": ["pip wheel hash mismatch intermittent CI",
                                                "setuptools-scm dirty version second build"],
             "results": [{"title": "setuptools-scm: dirty versions", "url": "https://docs.example.com/setuptools-scm/dirty",
                          "snippet": "A build in a modified tree appends +dirty to the version."}]}),
        (1, cmd("/bin/bash -lc \"git log --oneline -4 release/1.2\"",
                "565ff6b Work in progress on release/1.2\n2c1d0e9 Note the 1.1.1 fixes\n"
                "8f3a7b2 Add the entry point\n41c9e5d Start a changelog\n")),
        (1, cmd("/bin/bash -lc \"pip install dist/borealis_cli-1.2.0-py3-none-any.whl\"",
                "ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE.\n"
                "    borealis-cli==1.2.0 from dist/borealis_cli-1.2.0-py3-none-any.whl:\n"
                "        Expected sha256 9b1f…c2\n             Got        41aa…7e\n", exit_code=1)),
        (1, think("The hash only changes when the release job builds twice. The second build runs "
                  "after `CHANGELOG.md` is rewritten, so setuptools-scm sees a dirty tree.")),
        (1, child_card("bor-wheel-check", "Rebuild the wheel twice in one job and diff the METADATA "
                       "files.")),
        (1, bg("while ! ls dist/*.whl >/dev/null 2>&1; do sleep 10; done", "call_mockwheelwatch",
               "waiting for dist/*.whl\nwaiting for dist/*.whl\nwaiting for dist/*.whl\n")),
        (1, say("Root cause: the release job builds the wheel twice, and the second build sees a "
                "dirty tree, so the version becomes `1.2.0+dirty` and the hash changes.\n\n"
                "I've asked a Checker to confirm from the METADATA files and I'm watching `dist/` "
                "for the rebuilt wheel.")),
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
        (1, edit(f"{wt('aurora', 'refactor/theme-layers')}/src/theme.css", json.dumps({
            "filePath": f"{wt('aurora', 'refactor/theme-layers')}/src/theme.css",
            "oldString": ":root {\n  --sidebar-bg: #0b1020;\n  --sidebar-fg: #e6e9f2;",
            "newString": "@layer tokens {\n  :root {\n    --sidebar-bg: #0b1020;\n    --sidebar-fg: #e6e9f2;",
            "replaceAll": False}), 4, 3)),
        (1, {"type": "error", "title": "Usage limit reached"}),
    ],
    "ech-ci-matrix": [
        (1, user("Move CI to a matrix over Python 3.11 to 3.13 and Node 20 and 22.")),
        (1, edit(f"{wt('echo', 'ci/matrix')}/.github/workflows/ci.yml",
                 "@@ -0,0 +1,12 @@\n+name: ci\n+on: [push, pull_request]\n+jobs:\n+  test:\n"
                 "+    strategy:\n+      matrix:\n+        python: [\"3.11\", \"3.12\", \"3.13\"]\n"
                 "+        node: [20, 22]\n+    runs-on: ubuntu-latest\n+    steps:\n"
                 "+      - uses: actions/checkout@v4\n+      - run: make test\n", 12, 0)),
        (1, cmd("/bin/bash -lc \"act -j test --matrix python:3.13\"",
                "Error: Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n",
                exit_code=1)),
        (1, {"type": "error", "title": "Provider error"}),
    ],
    "cas-campaign": [
        (1, user("Run the 10k-cell benchmark campaign across the solver variants and report a "
                 "speed-up table.")),
        (1, {"type": "todo_list", "explanation": "Kernel port and benchmarks run in parallel.",
             "steps": [("Port the kernel to Numba", "running"),
                       ("Benchmark 1k, 10k and 100k grids", "running"),
                       ("Review the harness", "running"),
                       ("Choose plot styling", "running"),
                       ("Write the speed-up table", "pending")]}),
        (1, child_card("cas-numba", "Port flux_update to Numba and keep results bit-identical.", live=True)),
        (1, child_card("cas-bench", "Benchmark the three grid sizes in the background.", live=True)),
        (1, child_card("cas-harness-review", "Review scripts/bench.py for timing mistakes.", live=True)),
        (1, child_card("cas-plot-style", "Propose a plot style for the report.", live=True)),
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
        (1, say("The 1k and 10k grids are done (Numba is about 9x faster). The 100k grid is still "
                "running in the background; I'm watching its log.")),
    ],
    "cas-harness-review": [
        (1, user("Review scripts/bench.py for timing mistakes.", by="agent")),
        (1, cmd("/bin/bash -lc \"rg -n 'perf_counter|time.time' scripts/bench.py\"",
                "scripts/bench.py:22:    start = time.time()\nscripts/bench.py:31:    elapsed = time.time() - start\n")),
        (1, {"type": "approval_request", "requestKind": "command",
             "prompt": "rm -rf results/stale && uv run python scripts/bench.py --verify"}),
    ],
    "cas-plot-style": [
        (1, user("Propose a plot style for the report.", by="agent")),
        (1, say("Two styles fit the report. I need you to pick one.")),
        (1, {"type": "user_input_request", "questions": [
            {"id": "style", "header": "Plot style",
             "question": "Which style should the speed-up plots use?",
             "options": [{"label": "Log-log lines (Recommended)", "description": "Shows scaling across grid sizes."},
                         {"label": "Grouped bars", "description": "Easier to read for three sizes."}],
             "multiSelect": False}]}),
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
    "aur-gradient-header": [
        (1, user("Build the gradient header from the audited tokens; add a visual test.", by="agent")),
        (1, cmd("/bin/bash -lc \"rg -n 'sidebar-' src/theme.css | head -3\"",
                "src/theme.css:2:  --sidebar-bg: #0b1020;\nsrc/theme.css:3:  --sidebar-fg: #e6e9f2;\n")),
        # A foreground command still running: listed under the thread in Projects.
        (1, {"type": "command_execution", "status": "running", "live": True,
             "input": "/bin/bash -lc \"pnpm vitest run src/components/GradientHeader.test.tsx\""}),
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
                if child and "gh_issue" in child:
                    child["title"] = f"#{child['gh_issue']} {sandbox_issue(child['gh_issue'])['title']}"
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
    apps, research, experiments, inbox = (uid(f"section/{name}") for name in
                                          ("apps", "research", "experiments", "inbox"))
    return {
        "sidebarProjectSections": [
            {"id": apps, "name": "Apps", "projectKeys": [PID["aurora"], PID["borealis"]],
             "collapsed": False, "color": "teal", "folderIcons": True},
            {"id": research, "name": "Research", "projectKeys": [], "collapsed": False},
            {"id": experiments, "name": "Experiments", "projectKeys": [PID["cascade"]],
             "collapsed": False, "parentId": research},
            {"id": inbox, "name": "Inbox", "projectKeys": [], "collapsed": False},
            {"id": uid("section/github-sandbox"), "name": "GitHub sandbox",
             "projectKeys": [PID["sandbox"]], "collapsed": False, "color": "indigo"},
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
