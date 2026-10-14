import {
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { assert, describe, it } from "vite-plus/test";

import { groupSpawnedProcesses, runningThreadWork } from "./threadProcesses.ts";

const threadId = ThreadId.make("thread-a");
const startedAt = DateTime.makeUnsafe("2026-10-14T10:00:00.000Z");

const commandItem = (
  id: string,
  status: OrchestrationV2TurnItem["status"],
  options: { readonly driver?: string; readonly runId?: string } = {},
) =>
  ({
    id: TurnItemId.make(id),
    threadId,
    runId: RunId.make(options.runId ?? "run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: {
      driver: ProviderDriverKind.make(options.driver ?? "codex"),
      nativeId: `native-${id}`,
      strength: "strong",
    },
    parentItemId: null,
    ordinal: 1,
    type: "command_execution",
    status,
    title: null,
    input: `/bin/bash -lc 'python ${id}.py'`,
    startedAt,
    completedAt: null,
    updatedAt: startedAt,
  }) as OrchestrationV2TurnItem;

describe("runningThreadWork", () => {
  it("lists running command items the roster does not, outside rolled-back runs", () => {
    const work = runningThreadWork({
      threadId,
      ownRoster: [{ taskId: "native-shell", kind: "command", command: "npm run dev" }],
      parentRoster: [],
      turnItems: [
        commandItem("fit", "running"),
        commandItem("claude", "running", { driver: "claudeAgent" }),
        commandItem("done", "completed"),
        commandItem("shell", "running"),
        commandItem("abandoned", "running", { runId: "run-0" }),
      ],
      runs: [
        { id: RunId.make("run-0"), ordinal: 0, status: "rolled_back" },
        { id: RunId.make("run-1"), ordinal: 1, status: "running" },
      ],
    });
    assert.deepEqual(work.commands, [
      {
        taskId: "native-fit",
        command: "/bin/bash -lc 'python fit.py'",
        commandKind: "python",
        startedAt: "2026-10-14T10:00:00.000Z",
        followable: true,
      },
      {
        taskId: "native-claude",
        command: "/bin/bash -lc 'python claude.py'",
        commandKind: "python",
        startedAt: "2026-10-14T10:00:00.000Z",
        // Claude reports a foreground command's output only when it ends.
        followable: false,
      },
    ]);
    // The roster's shell is running too, once, as a task.
    assert.deepEqual(
      work.tasks.map((task) => task.taskId),
      ["native-shell", "native-fit", "native-claude"],
    );
  });
});

describe("groupSpawnedProcesses", () => {
  const process = (pid: number, ppid: number, command: string, cpuPercent = 10) => ({
    identity: { pid, startTimeMs: 1 },
    ppid,
    command,
    cpuPercent,
    residentBytes: 100,
  });

  it("groups same-shaped workers under a Codex command into one row with their total usage", () => {
    const { groups, hiddenCount } = groupSpawnedProcesses({
      processes: [
        process(1, 0, "node server"),
        process(10, 1, "codex app-server"),
        process(20, 10, "/bin/bash -lc python launch.py --workers 3"),
        process(21, 20, "python launch.py --workers 3"),
        ...[1, 2, 3].map((shard) =>
          process(30 + shard, 21, `/usr/bin/python3 /work/worker.py --shard ${shard}`),
        ),
        process(40, 21, "sleep 5"),
        process(50, 10, "/usr/bin/python3 /work/worker.py --shard 9"),
      ],
      serverPid: 1,
      commands: [{ command: "/bin/bash -lc 'python launch.py --workers 3'" }],
    });
    // The command's own processes are its row; waits and other trees are not its processes.
    assert.deepEqual(groups, [
      { label: "python3 worker.py --shard #", count: 3, cpuPercent: 30, residentBytes: 300 },
    ]);
    assert.equal(hiddenCount, 0);
  });

  it("lists the largest groups first and counts the rest past the cap", () => {
    const children = ["a", "a", "a", "b", "b", "c", "d", "e", "f"].map((name, index) =>
      process(100 + index, 20, `tool-${name}`),
    );
    const { groups, hiddenCount } = groupSpawnedProcesses({
      processes: [process(20, 1, "make all"), ...children],
      serverPid: 1,
      commands: [{ command: "make all" }],
      limit: 3,
    });
    assert.deepEqual(
      groups.map((group) => [group.label, group.count]),
      [
        ["tool-a", 3],
        ["tool-b", 2],
        ["tool-c", 1],
      ],
    );
    assert.equal(hiddenCount, 3);
  });
});
