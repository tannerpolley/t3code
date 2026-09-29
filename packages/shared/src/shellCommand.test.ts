import { assert, describe, it } from "vite-plus/test";

import { classifyShellCommand, shellCommandWaitPids, shellCommandWords } from "./shellCommand.ts";

describe("classifyShellCommand", () => {
  // Real background commands agents ran (Claude Bash and Monitor, Codex), trimmed.
  const cases: ReadonlyArray<readonly [string, string]> = [
    // Detached jobs, venv paths, env assignments and wrappers.
    ["setsid nohup .venv/bin/python fit.py > run.log 2>&1 &", "python"],
    [
      'WT=/w/model-d; cd $WT/analyses && export OMP_NUM_THREADS=1 && $WT/.venv/bin/python -m analyses.refit --seed 1 > "$R/seed.log" 2>&1',
      "python",
    ],
    [
      `/bin/bash -lc "PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=1 /home/me/MEA/.venv/bin/python3.12 - <<'PY'\nimport sys\nPY"`,
      "python",
    ],
    ["nice -n 10 ionice -c3 timeout 3600 stdbuf -oL python3 -u train.py", "python"],
    // Test runners through runners and interpreters.
    ["uv run --with pytest-xdist pytest -n 4 tests/", "pytest"],
    ["python -m pytest -x tests/test_fit.py", "pytest"],
    ["conda run -n mea python solve.py", "python"],
    ["uv sync --all-extras", "uv"],
    // Codex wraps every command in a login shell; the JS toolchain is node.
    ["/bin/bash -lc 'npm test'", "node"],
    ["bash run.sh", "bash"],
    [
      'cd /w/t3code && (nice -n 10 vp i > /tmp/install.log 2>&1; echo "exit $?" >> /tmp/install.log)',
      "node",
    ],
    [
      "for i in $(seq 1 40); do awk '{exit !($1>8)}' /proc/loadavg || break; sleep 15; done; flock /tmp/t3-heavy-check.lock nice -n 10 vp test run a.test.ts",
      "node",
    ],
    ["bunx vitest run", "bun"],
    // Other toolchains.
    ["make -j4 all", "make"],
    ["cargo test --workspace", "rust"],
    ["Rscript analysis/fit.R", "r"],
    ["julia --project=. scripts/run.jl", "julia"],
    ["go test ./...", "go"],
    ["./gradlew build", "java"],
    ["docker compose up db", "docker"],
    ["latexmk -pdf main.tex", "latex"],
    // Watchers: commands that wait for another process, a file or a log change.
    [
      "while kill -0 123 2>/dev/null; do sleep 20; done; grep -E 'accepted|failed' /tmp/run.log",
      "watcher",
    ],
    [
      "until grep -q CAMPAIGN_DONE tmp/run_all.log; do sleep 20; done; tail -5 tmp/run_all.log",
      "watcher",
    ],
    ["timeout 600 bash -c 'until [ -s out.csv ]; do sleep 5; done'", "watcher"],
    ["while kill -0 123; do :; done", "watcher"],
    ["until test -s out.csv; do :; done", "watcher"],
    ["tail --pid=4242 -f /dev/null", "watcher"],
    ["tail -n 0 -F run.log", "watcher"],
    ["inotifywait -m -e close_write run.log", "watcher"],
    ["watch -n 1 python fit.py", "watcher"],
    // A job after its wait is what the task runs; git only names a task that does nothing else.
    ["while kill -0 99; do sleep 30; done; python summarize.py", "python"],
    ["git pull --ff-only && make", "make"],
    ["git status --short; git diff --check", "git"],
    // Unknown programs fall back to a shell.
    ['tail -n 0 -f /tmp/replay.log | grep -E --line-buffered "Traceback|Error"', "watcher"],
    ["build/repin/run.sh 2>&1 | tee build/repin/run.log", "shell"],
    ["", "shell"],
  ];
  for (const [command, kind] of cases) {
    it(`${kind}: ${command.slice(0, 60)}`, () => {
      assert.equal(classifyShellCommand(command), kind);
    });
  }
});

describe("shellCommandWords", () => {
  it("splits simple commands and drops redirect targets", () => {
    assert.deepEqual(shellCommandWords(`cd /w && nohup python "a b.py" > log 2>&1 &\nsleep $N`), [
      ["cd", "/w"],
      ["nohup", "python", "a b.py"],
      ["sleep", "$N"],
    ]);
  });

  it("finds only literal PIDs used by supported wait commands", () => {
    assert.deepEqual(
      shellCommandWaitPids(
        "while kill -0 123 2>/dev/null; do sleep 5; done; tail --pid=456 -f /dev/null",
      ),
      [123, 456],
    );
    assert.isNull(shellCommandWaitPids("while kill -0 $PID; do sleep 5; done"));
    assert.isNull(shellCommandWaitPids("wait $CHILD"));
  });
});
