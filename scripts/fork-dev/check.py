#!/usr/bin/env python3
"""Offline seed check. All generated files stay in a temporary directory.

Optionally pass an empty, migrated SQLite database to exercise base/live against a copy.
No server, systemd or GitHub calls are made.
"""
import json
import sqlite3
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import seed


def check(database=None):
    with tempfile.TemporaryDirectory(prefix="t3-dev-seed-check-") as tmp:
        root = Path(tmp)
        fixture = root / "fixtures"
        userdata = root / "userdata"
        userdata.mkdir()
        login = root / "login"
        login.mkdir()
        seed.git(str(login), "init", "-q", "-b", "main")
        (login / "README.md").write_text("Offline checkpoint test\n")
        seed.git(str(login), "add", "README.md")
        seed.git(str(login), "commit", "-q", "-m", "Initial commit")

        def github(path):
            if path == f"repos/{seed.SANDBOX_REPO}":
                return {"id": 42}
            number = int(path.rsplit("/", 1)[1])
            return {"id": 1000 + number, "node_id": f"offline-{number}",
                    "html_url": f"https://github.com/{seed.SANDBOX_REPO}/issues/{number}",
                    "title": f"Offline issue {number}"}

        with (patch.multiple(seed, ROOT=root, USERDATA=userdata, FIXTURE=fixture,
                             AURORA_LOGIN=str(login)), patch.object(seed, "github", github)):
            assert len(seed.PROJECTS) == 8
            assert len(seed.BY_KEY) == len(seed.THREADS)
            assert set(seed.TIMELINES) <= seed.BY_KEY.keys()
            for project in seed.PROJECTS:
                owners = [s for s in seed.THREADS if s["project"] == project and s["role"] == "orchestrator"]
                assert len(owners) == 1, project
            for spec in seed.THREADS:
                assert spec["title"].startswith("Check: "), spec["key"]
                if parent := seed.BY_KEY.get(spec.get("parent")):
                    assert spec["project"] == parent["project"]
                    assert seed.at(**spec["created"]) >= seed.at(**parent["created"]), spec["key"]
                seed.thread_row(spec)
                list(seed.timeline_rows(spec))
            assert {s.get("agent_type") for s in seed.THREADS} >= {"general-purpose", "worker", "explorer", "Explore", "code-reviewer", "tester"}
            seed.write_process_fixture()
            processes = json.loads((fixture / "processes.json").read_text())
            by_pid = {p["pid"]: p for p in processes}
            assert len(processes) == len(by_pid)
            for process in processes:
                assert process["ppid"] == "server" or process["ppid"] in by_pid
                assert process["cpuPercent"] >= 0 and process["residentBytes"] > 0
            running_commands = {item["input"] for entries in seed.TIMELINES.values() for _, item in entries
                                if item["type"] == "command_execution" and item.get("status") == "running"}
            for command in running_commands:
                assert any(p["command"] in (command, f"bash -c {command}") for p in processes), command
            layout = seed.sidebar_layout()
            assert any(s["name"] == "INBOX" and not s["projectKeys"] for s in layout["sidebarProjectSections"])
            assert any("parentId" in s for s in layout["sidebarProjectSections"])
            assert len(seed.BY_KEY["badge-orchestrate"]["prs"]) == 123
            assert {pr["snapshot"]["state"] for spec in seed.THREADS for pr in spec.get("prs", [])} == {"open", "closed", "merged"}
            if database:
                target = userdata / "statev2.sqlite"
                with sqlite3.connect(f"{Path(database).resolve().as_uri()}?mode=ro", uri=True) as source:
                    with sqlite3.connect(target) as db:
                        source.backup(db)
                with sqlite3.connect(target) as db:
                    seed.base(db)
                    seed.live(db)
                    seed.live(db)  # Restore after restart and repeated live calls must be idempotent.
                    assert db.execute("SELECT count(*) FROM projection_projects").fetchone()[0] == 8
                    assert db.execute("SELECT count(*) FROM orchestration_v2_projection_threads").fetchone()[0] == len(seed.THREADS)
                    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                    assert not db.execute("PRAGMA foreign_key_check").fetchall()
                    print("base + live + repeated live: passed on temporary migrated database copy")
            print(f"Offline checks passed: {len(seed.PROJECTS)} projects, {len(seed.THREADS)} threads, {len(processes)} processes")


if __name__ == "__main__":
    if len(sys.argv) > 2:
        sys.exit("usage: check.py [empty-migrated-database]")
    check(sys.argv[1] if len(sys.argv) == 2 else None)
