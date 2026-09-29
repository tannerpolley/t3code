import { assert, describe, it } from "vite-plus/test";

import { watchedLogPaths } from "./watchedLogPaths.ts";

const cwd = "/work/project";
const home = "/home/me";
const paths = (command: string) => watchedLogPaths(command, cwd, home);

describe("watchedLogPaths", () => {
  it("finds the log a wait loop greps once the watched process exits", () => {
    assert.deepEqual(
      paths(
        'while kill -0 339997 2>/dev/null; do sleep 20; done; grep -E "accepted in|failed in|CAMPAIGN_DONE" /data/Lithium/tmp/sapon/run_all.log',
      ),
      ["/data/Lithium/tmp/sapon/run_all.log"],
    );
  });

  it("resolves relative paths after a cd, and skips grep patterns", () => {
    assert.deepEqual(
      paths(
        'cd /data/Lithium && until grep -q CAMPAIGN_DONE tmp/sapon/run_all.log; do sleep 20; done; grep -E "accepted in|failed in" tmp/sapon/run_all.log | tail -9; cat analyses/hbta/results/campaign.json | head -5',
      ),
      ["/data/Lithium/tmp/sapon/run_all.log", "/data/Lithium/analyses/hbta/results/campaign.json"],
    );
    assert.deepEqual(paths("grep -c ERROR logs/run.log"), ["/work/project/logs/run.log"]);
    assert.deepEqual(paths("grep -e ERROR -m 1 run.log other.log"), [
      "/work/project/run.log",
      "/work/project/other.log",
    ]);
    assert.deepEqual(paths('rg -g "*.py" TODO src/main.py'), ["/work/project/src/main.py"]);
  });

  it("follows the files a monitor tails, not the pattern it filters with", () => {
    assert.deepEqual(
      paths(
        'tail -n +1 -f /tmp/a64/replay.log | grep -E --line-buffered "] (start|done) |Traceback"',
      ),
      ["/tmp/a64/replay.log"],
    );
    assert.deepEqual(
      paths(
        'tail -n0 -F /tmp/li158/fit.log /tmp/li158/run.out 2>/dev/null | grep -E --line-buffered "FAILED|Traceback" & while kill -0 893005 2>/dev/null; do sleep 30; done',
      ),
      ["/tmp/li158/fit.log", "/tmp/li158/run.out"],
    );
  });

  it("finds redirect and tee targets of a detached launch", () => {
    assert.deepEqual(paths("setsid nohup .venv/bin/python x.py > /tmp/i161/chloride.log 2>&1 &"), [
      "/tmp/i161/chloride.log",
    ]);
    assert.deepEqual(paths("make >>build.log 2>err.log; ./run &> all.log | tee -a copy.log"), [
      "/work/project/build.log",
      "/work/project/err.log",
      "/work/project/all.log",
      "/work/project/copy.log",
    ]);
  });

  it("expands ~/ and simple assignments, and skips what it cannot know", () => {
    assert.deepEqual(paths("tail -F ~/logs/a.log"), ["/home/me/logs/a.log"]);
    assert.deepEqual(paths('R=/runs/model-d; sleep 5; tail -n0 -F "$R/1.log" ${R}/2.log'), [
      "/runs/model-d/1.log",
      "/runs/model-d/2.log",
    ]);
    assert.deepEqual(paths("tail -F $LOG_DIR/a.log /tmp/*.log ~other/b.log $(ls x) `pwd`/c"), []);
    assert.deepEqual(paths("cd $SOMEWHERE && tail -F rel.log /abs.log"), ["/abs.log"]);
    assert.deepEqual(paths("cat 'it''s $HOME.log' < input.txt > /dev/null"), [
      "/work/project/its $HOME.log",
    ]);
  });

  it("reads the script inside bash -lc and skips heredoc bodies", () => {
    assert.deepEqual(paths("/bin/bash -lc 'cd sub && tail -f out.log'"), [
      "/work/project/sub/out.log",
    ]);
    assert.deepEqual(
      paths("python3 - <<'EOF' > result.txt\ncat not-a-command.log\nEOF\nhead -3 result.txt"),
      ["/work/project/result.txt"],
    );
  });
});
