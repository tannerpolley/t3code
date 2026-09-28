import * as DateTime from "effect/DateTime";
import { pendingBackgroundWorkOfThread } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { describe, expect, it } from "vite-plus/test";

import {
  describeBackgroundWorkTasks,
  describeSidebarBackgroundWork,
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
          { taskId: "item-2", taskType: "command_execution" },
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
      { taskId: "item-2", label: "item-2", kind: "process", startedAt: null, childThreadId: null },
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
        { taskId: "bash-1", description: "sleep 20", taskType: "local_bash" },
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
        startedAt: null,
        childThreadId: null,
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
        childThreadId: "child-thread",
      },
    ] as never;
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
    // Lineage's own rows for the parent leave the child's shell to the child.
    expect(
      pendingBackgroundWorkOfThread("parent-thread", parentRoster).map((task) => task.taskId),
    ).toEqual(["bash-own"]);
  });
});
