#!/usr/bin/env python3
"""Lists fork code an upstream merge may have dropped while resolving conflicts.

A line counts when the fork added it after the merge base, in a file both sides changed, and
no longer appears anywhere in the merged file (whitespace ignored, so restyled code still
matches). Fork-added files that are gone or no longer imported are listed too. Every flagged
hunk needs a judgment: restyled, replaced by upstream's own version, or dropped and to restore.

usage: scripts/fork-sync/lost-fork-code.py <main-before-merge> <upstream-merged> [<merged>]
"""

import re
import subprocess
import sys


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True)


def changed(a: str, b: str) -> set[str]:
    return set(git("diff", "--name-only", a, b).splitlines())


def squash(text: str) -> str:
    return re.sub(r"\s+", "", text).rstrip(",;")


def meaningful(line: str) -> bool:
    line = line.strip()
    return len(re.findall(r"[A-Za-z0-9_$]+", line)) >= 2 and not line.startswith(
        ("import ", "} from ", "//", "/*", "*", "#", "export type ")
    )


if len(sys.argv) not in (3, 4):
    sys.exit(__doc__)
fork, upstream = sys.argv[1], sys.argv[2]
merged = sys.argv[3] if len(sys.argv) == 4 else "HEAD"
base = git("merge-base", fork, upstream).strip()
tracked = set(git("ls-tree", "-r", "--name-only", merged).splitlines())
both = sorted(changed(base, fork) & changed(base, upstream))

flagged = 0
for path in both:
    if path not in tracked:
        print(f"\n## {path}: the merge deleted this file")
        flagged += 1
        continue
    merged_text = squash(git("show", f"{merged}:{path}"))
    diff = git("diff", "-w", "--unified=0", base, fork, "--", path)
    for hunk in re.split(r"(?=^@@ )", diff, flags=re.M)[1:]:
        header, *body = hunk.splitlines()
        missing = [
            line[1:].strip()
            for line in body
            if line.startswith("+") and meaningful(line[1:]) and squash(line[1:]) not in merged_text
        ]
        if missing:
            flagged += 1
            print(f"\n## {path} {header}")
            print("\n".join(f"  {line}" for line in missing))

# A fork file the merge kept can still be dead: its only importer was an upstream file.
imports = git("grep", "-h", "-o", "-E", r"""(from |import\()["'][^"']+["']""", merged)
added = git("diff", "--name-only", "--diff-filter=A", base, fork).splitlines()
gone = [path for path in added if path not in tracked]
orphaned = [
    path
    for path in added
    if path in tracked
    and re.search(r"\.tsx?$", path)
    # Tests and directly run scripts and entry points have no importer by design.
    and not re.search(r"\.(test|bench)\.tsx?$|/(index|main|bin)\.tsx?$|(^|/)scripts/", path)
    and f"/{re.sub(r'\.tsx?$', '', path.rsplit('/', 1)[-1])}" not in imports
]
for path in gone:
    print(f"\n## {path}: fork-added file the merge deleted")
for path in orphaned:
    print(f"\n## {path}: fork-added file nothing imports any more")

print(
    f"\n{flagged} hunks flagged in {len(both)} files both sides changed; "
    f"{len(gone)} fork files deleted, {len(orphaned)} no longer imported (base {base[:10]})"
)
