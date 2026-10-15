#!/usr/bin/env python3
"""Showcase issues and pull requests in the private sandbox repository tannerpolley/t3code-sandbox.

Run it with t3-dev stopped and before its database is rebuilt (seed.sh does both): the dev
server's issue inbox treats issues opened after it started watching as external and labels them
on GitHub (external, priority: high), even with repository work paused.

Re-runnable: everything is found by title (labels, milestones, issues, PRs) or by name
(branches) before it is created, and relationships are added only when missing. The only
GitHub writes in the fixture; the dev instance itself never writes to GitHub.

  python3 github.py          create or complete the showcase set, then print the number map
"""
import base64
import json
import subprocess
import sys

REPO = "tannerpolley/t3code-sandbox"
ME = "tannerpolley"
API = f"repos/{REPO}"


def gh(path, method="GET", body=None, paginate=False):
    args = ["gh", "api", path, "-X", method] + (["--paginate", "--slurp"] if paginate else [])
    if body is not None:
        args += ["--input", "-"]
    out = subprocess.run(args, input=json.dumps(body) if body is not None else None,
                         capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"gh api {method} {path} failed: {out.stderr.strip() or out.stdout.strip()}")
    data = json.loads(out.stdout) if out.stdout.strip() else None
    return [item for page in data for item in page] if paginate else data


LABELS = {"bug": "d73a4a", "enhancement": "a2eeef", "documentation": "0075ca",
          "priority: high": "b60205", "external": "5319e7", "from:aurora-web": "c5def5",
          "from:cascade-sim": "c5def5"}
MILESTONES = {"02 - Release 1.0": "2026-11-15T00:00:00Z"}

# key: title, body, labels, milestone, assigned, state ("open", "completed", "not_planned"),
# parent (key or existing number), blocked_by (keys or numbers), comments.
SOURCE = ("<!-- t3-source project={project} repository=github.com%2Ft3-dev-mock%2F{project} "
          "thread=thread%3Amock -->")
ISSUES = {
    "unit-safe": dict(
        title="Unit-safe temperature API",
        body="## Goal\nStop mixing up bare floats: conversions take and return a `Temperature` "
             "value that knows its unit.\n\n## Done when\n- Every sub-issue is closed or "
             "consciously dropped\n- The old float functions stay as thin wrappers",
        labels=["enhancement"], milestone="02 - Release 1.0", assigned=True,
        comments=["Splitting this into sub-issues so they can land one PR at a time."]),
    "value-type": dict(
        title="Introduce a Temperature value type", parent="unit-safe",
        body="A frozen dataclass `Temperature(value, unit)` with `to(unit)`.",
        labels=["enhancement"], milestone="02 - Release 1.0", assigned=True, state="completed"),
    "absolute-zero": dict(
        title="Reject temperatures below absolute zero", parent="unit-safe",
        blocked_by=["value-type"],
        body="`Temperature(-300, 'C')` should raise `ValueError` instead of returning nonsense.",
        labels=["bug"], milestone="02 - Release 1.0", assigned=True,
        comments=["Should -273.15 C itself be allowed? I think yes, it's the boundary.",
                  "Agreed: allow the boundary, reject anything below it."]),
    "parse": dict(
        title="Parse strings like \"72F\" and \"300 K\"", parent="unit-safe",
        blocked_by=["absolute-zero"],
        body="`Temperature.parse(text)` for the CLI and the demo page.",
        labels=["enhancement"], milestone="02 - Release 1.0", assigned=True),
    "degree-sign": dict(
        title="Accept the degree sign in parsed input", parent="parse",
        body="`72°F` and `21 °C` should parse the same as `72F` and `21 C`.",
        labels=["enhancement"], milestone="02 - Release 1.0"),
    "precision": dict(
        title="Format temperatures with a chosen precision", parent="unit-safe",
        body="A `precision=` argument on `str(Temperature)`.",
        labels=["enhancement"], milestone="02 - Release 1.0", state="not_planned",
        comments=["Dropping this: f-strings already cover it (`f\"{t.value:.1f}\"`)."]),
    "pypi": dict(
        title="Publish 1.0 to PyPI", blocked_by=["unit-safe", 3],
        body="Tag `v1.0.0`, build the wheel and upload it once the API and CI are in place.",
        labels=["priority: high"], milestone="02 - Release 1.0", assigned=True),
    "absolute-zero-bug": dict(
        title="c_to_f(-273.15) prints -459.66999999999996",
        body="```\n>>> c_to_f(-273.15)\n-459.66999999999996\n```\nExpected `-459.67`.",
        labels=["bug", "priority: high"], milestone="00 - Foundation", assigned=True,
        comments=["Same float drift as #4; whatever fixes #4 should fix this."]),
    "inbox-json": dict(
        title="Expose a JSON conversion endpoint for aurora-web",
        body="aurora-web's settings page wants to show temperatures in the user's unit. A tiny "
             "`/convert?value=21&from=C&to=F` endpoint would do.\n\n"
             + SOURCE.format(project="aurora-web"),
        labels=["external", "from:aurora-web", "priority: high"]),
    "inbox-vector": dict(
        title="Vectorized conversions for cascade-sim grids",
        body="cascade-sim converts 10k-cell temperature grids; accepting NumPy arrays in "
             "`c_to_k` would avoid a Python loop.\n\n" + SOURCE.format(project="cascade-sim"),
        # T3's inbox watcher gives a marked issue all three receiver labels; keep them so it
        # never has a label left to add.
        labels=["external", "from:cascade-sim", "priority: high"], milestone="Extension - Ideas"),
}

# Pull requests that say `Closes #N`: branch, files written on it, draft, merged.
CONVERTER = """\"\"\"Temperature unit converter.\"\"\"
from dataclasses import dataclass

ABSOLUTE_ZERO_C = -273.15


@dataclass(frozen=True)
class Temperature:
    value: float
    unit: str  # "C", "F" or "K"

    def to(self, unit: str) -> "Temperature":
        celsius = {"C": self.value, "F": f_to_c(self.value), "K": self.value - 273.15}[self.unit]
        return Temperature({"C": celsius, "F": c_to_f(celsius), "K": c_to_k(celsius)}[unit], unit)


def c_to_f(celsius: float) -> float:
    return celsius * 9 / 5 + 32


def f_to_c(fahrenheit: float) -> float:
    return (fahrenheit - 32) * 5 / 9


def c_to_k(celsius: float) -> float:
    return celsius + 273.15
"""
PULLS = {
    "value-type": dict(
        title="Add a Temperature value type", branch="feature/temperature-type", merged=True,
        files={"converter.py": CONVERTER}),
    "absolute-zero": dict(
        title="Reject temperatures below absolute zero", branch="fix/absolute-zero",
        files={"guards.py": "from converter import ABSOLUTE_ZERO_C\n\n\n"
                            "def check_celsius(value: float) -> float:\n"
                            "    if value < ABSOLUTE_ZERO_C:\n"
                            "        raise ValueError(f\"{value} C is below absolute zero\")\n"
                            "    return value\n"}),
    "parse": dict(
        title="Parse temperature strings", branch="feature/parse", draft=True,
        files={"parse.py": "import re\n\nfrom converter import Temperature\n\n"
                           "PATTERN = re.compile(r\"^\\s*(-?\\d+(?:\\.\\d+)?)\\s*([CFK])\\s*$\")\n\n\n"
                           "def parse(text: str) -> Temperature:\n"
                           "    match = PATTERN.match(text.upper())\n"
                           "    if match is None:\n"
                           "        raise ValueError(f\"not a temperature: {text!r}\")\n"
                           "    return Temperature(float(match[1]), match[2])\n"}),
}


def ensure_labels():
    have = {label["name"] for label in gh(f"{API}/labels?per_page=100", paginate=True)}
    for name, color in LABELS.items():
        if name not in have:
            gh(f"{API}/labels", "POST", {"name": name, "color": color})


def milestones():
    found = {m["title"]: m["number"] for m in gh(f"{API}/milestones?state=all&per_page=100",
                                                  paginate=True)}
    for title, due in MILESTONES.items():
        if title not in found:
            found[title] = gh(f"{API}/milestones", "POST", {"title": title, "due_on": due})["number"]
    return found


def ensure_issues(numbers):
    """Creates missing issues; returns key -> issue JSON."""
    existing = {i["title"]: i for i in gh(f"{API}/issues?state=all&per_page=100", paginate=True)
                if "pull_request" not in i}
    ms = milestones()
    issues = {}
    for key, spec in ISSUES.items():
        issue = existing.get(spec["title"])
        if issue is None:
            issue = gh(f"{API}/issues", "POST", {
                "title": spec["title"], "body": spec["body"], "labels": spec["labels"],
                **({"milestone": ms[spec["milestone"]]} if spec.get("milestone") else {}),
                **({"assignees": [ME]} if spec.get("assigned") else {})})
            for text in spec.get("comments", []):
                gh(f"{API}/issues/{issue['number']}/comments", "POST", {"body": text})
        elif sorted(label["name"] for label in issue["labels"]) != sorted(spec["labels"]):
            gh(f"{API}/issues/{issue['number']}/labels", "PUT", {"labels": spec["labels"]})
        issues[key] = issue
        numbers[key] = issue["number"]
    return issues


def ref(numbers, target):
    return target if isinstance(target, int) else numbers[target]


def ensure_relationships(numbers):
    for key, spec in ISSUES.items():
        number = numbers[key]
        if "parent" in spec:
            parent = ref(numbers, spec["parent"])
            subs = {s["number"] for s in gh(f"{API}/issues/{parent}/sub_issues?per_page=100")}
            if number not in subs:
                child_id = gh(f"{API}/issues/{number}")["id"]
                gh(f"{API}/issues/{parent}/sub_issues", "POST", {"sub_issue_id": child_id})
        if spec.get("blocked_by"):
            have = {b["number"] for b in gh(f"{API}/issues/{number}/dependencies/blocked_by")}
            for blocker in spec["blocked_by"]:
                blocker = ref(numbers, blocker)
                if blocker not in have:
                    blocker_id = gh(f"{API}/issues/{blocker}")["id"]
                    gh(f"{API}/issues/{number}/dependencies/blocked_by", "POST",
                       {"issue_id": blocker_id})


def ensure_branch(branch, files):
    try_ref = subprocess.run(["gh", "api", f"{API}/git/ref/heads/{branch}"], capture_output=True)
    if try_ref.returncode == 0:
        return
    main = gh(f"{API}/git/ref/heads/main")["object"]["sha"]
    gh(f"{API}/git/refs", "POST", {"ref": f"refs/heads/{branch}", "sha": main})
    for path, text in files.items():
        current = subprocess.run(["gh", "api", f"{API}/contents/{path}?ref={branch}"],
                                 capture_output=True, text=True)
        sha = json.loads(current.stdout)["sha"] if current.returncode == 0 else None
        gh(f"{API}/contents/{path}", "PUT", {
            "message": f"Update {path}" if sha else f"Add {path}", "branch": branch,
            "content": base64.b64encode(text.encode()).decode(), **({"sha": sha} if sha else {})})


def ensure_pulls(numbers):
    pulls = {p["title"]: p for p in gh(f"{API}/pulls?state=all&per_page=100", paginate=True)}
    for key, spec in PULLS.items():
        pull = pulls.get(spec["title"])
        if pull is None:
            ensure_branch(spec["branch"], spec["files"])
            pull = gh(f"{API}/pulls", "POST", {
                "title": spec["title"], "head": spec["branch"], "base": "main",
                "draft": spec.get("draft", False),
                "body": f"Closes #{numbers[key]}.\n\nSmall change for the T3 Code showcase."})
        if spec.get("merged") and pull.get("merged_at") is None:
            gh(f"{API}/pulls/{pull['number']}/merge", "PUT", {"merge_method": "squash"})
        numbers[f"pr:{key}"] = pull["number"]


def ensure_states(numbers):
    """Closes issues by their wanted reason (a merged `Closes #N` already closed some)."""
    for key, spec in ISSUES.items():
        reason = spec.get("state", "open")
        if reason == "open":
            continue
        issue = gh(f"{API}/issues/{numbers[key]}")
        if issue["state"] != "closed" or issue["state_reason"] != reason:
            gh(f"{API}/issues/{numbers[key]}", "PATCH", {"state": "closed", "state_reason": reason})


def main():
    numbers = {}
    ensure_labels()
    ensure_issues(numbers)
    ensure_relationships(numbers)
    ensure_pulls(numbers)
    ensure_states(numbers)
    print(json.dumps(numbers, indent=2))


if __name__ == "__main__":
    main()
