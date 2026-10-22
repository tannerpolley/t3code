import * as DateTime from "effect/DateTime";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  derivePendingBackgroundWork,
  pendingBackgroundWorkOfThread,
} from "./orchestrationV2PendingBackgroundWork.ts";

describe("derivePendingBackgroundWork", () => {
  it("returns pending work when the latest run is waiting (post-success, pre-checkpoint)", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "waiting" },
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "npm test",
          nativeItemRef: { nativeId: "cmd-1" },
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([
      {
        taskId: "cmd-1",
        description: "npm test",
        kind: "command",
        commandKind: "node",
        command: "npm test",
      },
    ]);
  });

  it("excludes rolled_back items when the latest run is waiting", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-2" as never, ordinal: 2, status: "waiting" },
      providerThreads: [{ id: "pt-1" as never }],
      runs: [
        { id: "run-1" as never, ordinal: 1, status: "rolled_back" },
        { id: "run-2" as never, ordinal: 2, status: "waiting" },
      ],
      turnItems: [
        {
          id: "item-old" as never,
          type: "command_execution",
          status: "running",
          title: "from rolled-back run",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-old" },
          input: "sleep 99",
        },
        {
          id: "item-new" as never,
          type: "command_execution",
          status: "running",
          title: "still pending",
          runId: "run-2",
          nativeItemRef: { nativeId: "cmd-new" },
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([
      {
        taskId: "cmd-new",
        description: "still pending",
        kind: "command",
        commandKind: "node",
        command: "npm test",
      },
    ]);
  });

  it("includes nonterminal turn items and excludes completed ones", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "npm test",
          nativeItemRef: { nativeId: "cmd-1" },
          input: "npm test",
        },
        {
          id: "item-2" as never,
          type: "command_execution",
          status: "completed",
          title: "done",
          nativeItemRef: { nativeId: "cmd-2" },
          input: "echo done",
        },
      ],
    });
    expect(tasks).toEqual([
      {
        taskId: "cmd-1",
        description: "npm test",
        kind: "command",
        commandKind: "node",
        command: "npm test",
      },
    ]);
  });

  it("excludes an older rolled_back nonterminal item when the latest run is completed", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-2" as never, ordinal: 2, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      runs: [
        { id: "run-1" as never, ordinal: 1, status: "rolled_back" },
        { id: "run-2" as never, ordinal: 2, status: "completed" },
      ],
      turnItems: [
        {
          id: "item-old" as never,
          type: "command_execution",
          status: "running",
          title: "from rolled-back run",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-old" },
          input: "sleep 99",
        },
        {
          id: "item-new" as never,
          type: "command_execution",
          status: "running",
          title: "still pending",
          runId: "run-2",
          nativeItemRef: { nativeId: "cmd-new" },
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([
      {
        taskId: "cmd-new",
        description: "still pending",
        kind: "command",
        commandKind: "node",
        command: "npm test",
      },
    ]);
  });

  it("includes items with a null run id even when runs list has rolled_back rows", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      runs: [{ id: "run-1" as never, ordinal: 1, status: "rolled_back" }],
      turnItems: [
        {
          id: "item-null-run" as never,
          type: "command_execution",
          status: "running",
          title: "orphan item",
          runId: null,
          nativeItemRef: { nativeId: "cmd-null" },
          input: "echo orphan",
        },
      ],
    });
    expect(tasks).toEqual([
      {
        taskId: "cmd-null",
        description: "orphan item",
        kind: "command",
        commandKind: "shell",
        command: "echo orphan",
      },
    ]);
  });
});

describe("derivePendingBackgroundWork kinds", () => {
  it("keeps the roster's kinds and names turn items by their type", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            { taskId: "bash", kind: "command" },
            { taskId: "watch", kind: "monitor" },
            { taskId: "workflow", kind: "background_task" },
          ],
        },
      ],
      turnItems: [
        {
          id: "item-sub" as never,
          type: "subagent",
          status: "running",
          title: "Review src/math.ts",
          nativeItemRef: { nativeId: "sub" },
          childThreadId: "thread:child" as never,
        },
        {
          id: "item-cmd" as never,
          type: "command_execution",
          status: "running",
          title: null,
          nativeItemRef: { nativeId: "cmd" },
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "bash", kind: "command" },
      { taskId: "watch", kind: "monitor" },
      { taskId: "workflow", kind: "background_task" },
      {
        taskId: "sub",
        description: "Review src/math.ts",
        kind: "subagent",
        childThreadId: "thread:child",
      },
      {
        taskId: "cmd",
        description: "npm test",
        kind: "command",
        commandKind: "node",
        command: "npm test",
      },
    ]);
  });
});

describe("background task metadata and ownership", () => {
  it("keeps the command start and classifies its executable after settlement", () => {
    const startedAt = DateTime.makeUnsafe("2026-09-23T10:00:00.000Z");
    expect(
      derivePendingBackgroundWork({
        latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
        providerThreads: [],
        turnItems: [
          {
            id: "python",
            type: "command_execution",
            status: "running",
            title: null,
            input: "  python fit.py  ",
            startedAt,
          },
        ],
      }),
    ).toEqual([
      {
        taskId: "python",
        kind: "command",
        description: "python fit.py",
        startedAt,
        commandKind: "python",
        command: "python fit.py",
      },
    ]);
  });
  it("keeps shared-session commands on their child and accepts legacy shell ownership", () => {
    const parent = ThreadId.make("parent"),
      child = ThreadId.make("child");
    const roster = [
      { taskId: "own", kind: "command" as const },
      { taskId: "nested", kind: "monitor" as const, ownerThreadId: child },
      { taskId: "legacy", kind: "background_task" as const, childThreadId: child },
      { taskId: "agent", kind: "subagent" as const, childThreadId: child },
    ];
    expect(pendingBackgroundWorkOfThread(parent, roster).map((task) => task.taskId)).toEqual([
      "own",
      "agent",
    ]);
    expect(pendingBackgroundWorkOfThread(child, [], roster).map((task) => task.taskId)).toEqual([
      "nested",
      "legacy",
    ]);
    expect(
      pendingBackgroundWorkOfThread(child, [roster[1]!], roster).map((task) => task.taskId),
    ).toEqual(["nested", "legacy"]);
  });
});
