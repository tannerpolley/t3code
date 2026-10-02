import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { pendingBackgroundWorkOfThread } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { describe, expect, it } from "vite-plus/test";

import {
  describeBackgroundWorkTasks,
  describeSidebarBackgroundWork,
  groupBackgroundWorkTaskRows,
  msUntilPossiblyStuck,
} from "./BackgroundWorkTaskList.logic";

const startedAt = DateTime.makeUnsafe("2026-09-23T10:00:00.000Z");

describe("describeBackgroundWorkTasks", () => {
  it("joins turn-item tasks to their subagent thread and start time", () => {
    const projection = {
      turnItems: [
        {
          id: "item-1",
          type: "subagent",
          subagentId: "node-1",
          childThreadId: null,
          nativeItemRef: { nativeId: "native-1" },
          startedAt,
        },
        { id: "item-2", type: "command_execution", nativeItemRef: null, startedAt: null },
      ],
      subagents: [{ id: "node-1", childThreadId: "child-thread", startedAt, nativeTaskRef: null }],
    } as never;
    expect(
      describeBackgroundWorkTasks(
        [
          { taskId: "native-1", description: "Review the diff", taskType: "subagent" },
          { taskId: "item-2", taskType: "command_execution", commandKind: "python" },
        ] as never,
        projection,
      ),
    ).toEqual([
      {
        taskId: "native-1",
        label: "Review the diff",
        kind: "subagent",
        startedAt: "2026-09-23T10:00:00.000Z",
        childThreadId: "child-thread",
      },
      {
        taskId: "item-2",
        label: "item-2",
        kind: "process",
        startedAt: null,
        childThreadId: null,
        taskType: "command_execution",
        commandKind: "python",
      },
    ]);
  });

  it("classifies roster-only tasks by their task type", () => {
    const rows = describeBackgroundWorkTasks(
      [
        { taskId: "bg-1", description: "sleep 20", taskType: "local_bash" },
        { taskId: "bg-2", description: "Explore", taskType: "local_agent" },
      ] as never,
      { turnItems: [], subagents: [] },
    );
    expect(rows.map((row) => row.kind)).toEqual(["process", "subagent"]);
  });
});

describe("describeSidebarBackgroundWork", () => {
  const runningChild = {
    id: "child-thread",
    title: "Review the diff",
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: true,
    runtime: {
      status: "running",
      activeRunId: null,
      activityStartedAt: "2026-09-23T10:00:00.000Z",
    },
  } as never;

  it("links running children, and lists processes and agents no child accounts for", () => {
    const rows = describeSidebarBackgroundWork(
      [
        { taskId: "agent-1", description: "Review the diff", taskType: "subagent" },
        { taskId: "agent-2", description: "Explore", taskType: "local_agent" },
        {
          taskId: "bash-1",
          description: "sleep 20",
          taskType: "local_bash",
          commandKind: "watcher",
          startedAt,
        },
      ] as never,
      [runningChild],
    );
    expect(rows).toEqual([
      {
        taskId: "child-thread",
        label: "Review the diff",
        kind: "subagent",
        startedAt: "2026-09-23T10:00:00.000Z",
        childThreadId: "child-thread",
        // A question outranks the running spinner, so the parent row can open the list.
        status: "input",
        child: runningChild,
      },
      {
        taskId: "agent-2",
        label: "Explore",
        kind: "subagent",
        startedAt: null,
        childThreadId: null,
      },
      {
        taskId: "bash-1",
        label: "sleep 20",
        kind: "process",
        // The roster's start time gives the shell its age.
        startedAt: "2026-09-23T10:00:00.000Z",
        childThreadId: null,
        taskType: "local_bash",
        commandKind: "watcher",
      },
    ]);
  });

  it("matches tasks that name their child by id, not by position", () => {
    // The first task's child finished its turn but still waits on its own work, so only the
    // second task's child is running.
    const rows = describeSidebarBackgroundWork(
      [
        {
          taskId: "item-waiting",
          description: "Recalibrate",
          taskType: "subagent",
          childThreadId: "waiting-thread",
        },
        {
          taskId: "item-running",
          description: "Review the diff",
          taskType: "subagent",
          childThreadId: "child-thread",
        },
      ] as never,
      [runningChild],
    );
    expect(rows.map((row) => [row.label, row.childThreadId])).toEqual([
      ["Review the diff", "child-thread"],
      ["Recalibrate", "waiting-thread"],
    ]);
  });

  it("nests a shell a subagent started on its parent's roster under that subagent", () => {
    // The child's turn ended; only the shell it started, which runs in the parent's session, remains.
    const finishedChild = {
      id: "child-thread",
      title: "Start the dev server",
      latestRun: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      runtime: null,
      pendingBackgroundTasks: [],
    };
    const parentRoster = [
      { taskId: "bash-own", description: "vp test", taskType: "local_bash" },
      {
        taskId: "bash-child",
        description: "npm run dev",
        taskType: "local_bash",
        childThreadId: ThreadId.make("child-thread"),
      },
    ];
    const parentRows = describeSidebarBackgroundWork(parentRoster, [finishedChild as never]);
    expect(parentRows.map((row) => [row.label, row.status])).toEqual([
      ["Start the dev server", "waiting"],
      ["vp test", undefined],
    ]);
    const childRows = describeSidebarBackgroundWork(
      pendingBackgroundWorkOfThread(
        "child-thread",
        finishedChild.pendingBackgroundTasks,
        parentRoster,
      ),
      [],
    );
    expect(childRows.map((row) => [row.label, row.kind])).toEqual([["npm run dev", "process"]]);
    const serverRoster = parentRoster.map((task) => ({
      ...task,
      ...(task.taskId === "bash-child" ? { commandKind: "server" } : {}),
    }));
    expect(
      describeSidebarBackgroundWork(serverRoster, [finishedChild as never]).map((row) => [
        row.label,
        row.status,
      ]),
    ).toEqual([
      ["Start the dev server", "ready"],
      ["vp test", undefined],
    ]);
    expect(
      describeBackgroundWorkTasks(pendingBackgroundWorkOfThread("child-thread", [], serverRoster), {
        turnItems: [],
        subagents: [],
      }),
    ).toMatchObject([{ label: "npm run dev", kind: "process", commandKind: "server" }]);
    // Lineage's own rows for the parent leave the child's shell to the child.
    expect(
      pendingBackgroundWorkOfThread("parent-thread", parentRoster).map((task) => task.taskId),
    ).toEqual(["bash-own"]);
  });
});

describe("groupBackgroundWorkTaskRows", () => {
  it("groups mixed agent and process rows while preserving their order, links, and owners", () => {
    const parent = ThreadId.make("parent-thread");
    const child = ThreadId.make("child-thread");
    const projection = {
      turnItems: [],
      subagents: [
        { id: "agent", nativeTaskRef: { nativeId: "codex-agent" }, childThreadId: child },
      ],
    } as never;
    const rows = describeBackgroundWorkTasks(
      [
        { taskId: "shell", taskType: "local_bash", commandKind: "python", startedAt },
        { taskId: "codex-agent", taskType: "subagent", description: "Check the diff" },
        { taskId: "monitor", taskType: "monitor", commandKind: "watcher", startedAt },
        { taskId: "claude-agent", taskType: "local_agent", description: "Explore" },
      ],
      projection,
    ).map((row) => ({ ...row, ownerThreadId: parent }));
    const { agents, processes } = groupBackgroundWorkTaskRows(rows);
    expect(agents.map((row) => row.taskId)).toEqual(["codex-agent", "claude-agent"]);
    expect(processes.map((row) => row.taskId)).toEqual(["shell", "monitor"]);
    expect(agents[0]?.childThreadId).toBe(child);
    expect(processes[0]?.ownerThreadId).toBe(parent);
    // Keep the original rows: their metadata and session ownership must reach output and Stop.
    expect(agents[0]).toBe(rows[1]);
    expect(agents[1]).toBe(rows[3]);
    expect(processes[0]).toBe(rows[0]);
    expect(processes[1]).toBe(rows[2]);
  });

  it("leaves an absent group empty for agent-only, process-only, and empty lists", () => {
    const rows = describeBackgroundWorkTasks(
      [
        { taskId: "agent", taskType: "remote_agent" },
        { taskId: "shell", taskType: "command_execution" },
      ],
      { turnItems: [], subagents: [] },
    );
    expect(groupBackgroundWorkTaskRows([rows[0]!])).toEqual({ agents: [rows[0]], processes: [] });
    expect(groupBackgroundWorkTaskRows([rows[1]!])).toEqual({ agents: [], processes: [rows[1]] });
    expect(groupBackgroundWorkTaskRows([])).toEqual({ agents: [], processes: [] });
  });
});

describe("msUntilPossiblyStuck", () => {
  it("counts down to two hours after the shell started, then stays at zero", () => {
    const started = Date.parse("2026-09-23T10:00:00.000Z");
    const minute = 60_000;
    expect(msUntilPossiblyStuck("2026-09-23T10:00:00.000Z", started + 119 * minute)).toBe(minute);
    expect(msUntilPossiblyStuck("2026-09-23T10:00:00.000Z", started + 120 * minute)).toBe(0);
    expect(msUntilPossiblyStuck("2026-09-23T10:00:00.000Z", started + 300 * minute)).toBe(0);
  });
});
