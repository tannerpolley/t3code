import {
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { pendingBackgroundWorkOfThread } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import {
  childWorktreeLabel,
  describeSidebarBackgroundWork,
  groupBackgroundWorkTaskRows,
  resolveSidebarThreadModelLabel,
  msUntilPossiblyStuck,
} from "./SidebarBackgroundWork.logic";

const runningChild = makeThreadFixture({
  id: ThreadId.make("child-thread"),
  title: "Review the diff",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-codex" },
  runtime: {
    status: "running",
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: "2026-09-23T10:00:00.000Z",
    activityStartedAt: "2026-09-23T10:00:00.000Z",
  },
});

describe("describeSidebarBackgroundWork", () => {
  it("deduplicates linked children and retains unmatched task kinds", () => {
    const rows = describeSidebarBackgroundWork(
      [
        {
          taskId: "linked-agent",
          description: "Review the diff",
          kind: "subagent",
          childThreadId: runningChild.id,
        },
        { taskId: "roster-agent", description: "Explore", kind: "subagent" },
        { taskId: "command", description: "Run tests", kind: "command" },
        { taskId: "monitor", description: "Watch build", kind: "monitor" },
        { taskId: "unknown", kind: "background_task" },
      ],
      [runningChild],
    );

    expect(rows.map(({ taskId, kind }) => [taskId, kind])).toEqual([
      [runningChild.id, "subagent"],
      ["roster-agent", "subagent"],
      ["command", "command"],
      ["monitor", "monitor"],
      ["unknown", "background_task"],
    ]);
    expect(rows[0]).toMatchObject({
      label: "Review the diff",
      childThreadId: runningChild.id,
      startedAt: "2026-09-23T10:00:00.000Z",
      status: "working",
      child: runningChild,
    });
    expect(rows[1]).toMatchObject({ childThreadId: null, startedAt: null });
    expect(rows[2]).not.toHaveProperty("childThreadId");
  });

  it("uses the pending-work kind to distinguish waiting from a leftover command", () => {
    const describe = (kind: "command" | "monitor" | "background_task") =>
      describeSidebarBackgroundWork(
        [],
        [
          {
            ...runningChild,
            latestRun: null,
            runtime: null,
            pendingBackgroundTasks: [{ taskId: "pending", kind }],
          },
        ],
      )[0]?.status;

    expect(describe("command")).toBe("ready");
    expect(describe("monitor")).toBe("waiting");
    expect(describe("background_task")).toBe("waiting");

    const idleWithoutRoster = {
      ...runningChild,
      runtime: {
        ...runningChild.runtime!,
        status: "idle" as const,
        activeRunId: null,
        activityStartedAt: null,
      },
      pendingBackgroundTasks: [],
    };
    expect(describeSidebarBackgroundWork([], [idleWithoutRoster])[0]?.status).toBe("waiting");
  });

  it("keeps a finished child waiting while its linked subagent task remains pending", () => {
    const finishedChild = {
      ...runningChild,
      latestRun: null,
      runtime: null,
      pendingBackgroundTasks: [],
    };

    expect(
      describeSidebarBackgroundWork(
        [{ taskId: "linked", kind: "subagent", childThreadId: finishedChild.id }],
        [finishedChild],
      )[0]?.status,
    ).toBe("waiting");
  });

  it("keeps a failed latest run visible when its runtime is idle", () => {
    const failedChild = {
      ...runningChild,
      latestRun: {
        runId: RunId.make("failed"),
        status: "failed" as const,
        requestedAt: null,
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
      runtime: {
        ...runningChild.runtime!,
        status: "idle" as const,
        activeRunId: null,
        activityStartedAt: null,
      },
      pendingBackgroundTasks: [{ taskId: "monitor", kind: "monitor" as const }],
    };

    expect(describeSidebarBackgroundWork([], [failedChild])[0]?.status).toBe("failed");
  });
});

describe("groupBackgroundWorkTaskRows", () => {
  it("groups agents and display-only background tasks without changing order", () => {
    const rows = describeSidebarBackgroundWork(
      [
        { taskId: "command", kind: "command" },
        { taskId: "agent", kind: "subagent" },
        { taskId: "monitor", kind: "monitor" },
      ],
      [],
    );
    const grouped = groupBackgroundWorkTaskRows(rows);

    expect(grouped.agents.map((row) => row.taskId)).toEqual(["agent"]);
    expect(grouped.backgroundTasks.map((row) => row.taskId)).toEqual(["command", "monitor"]);
    expect(groupBackgroundWorkTaskRows([])).toEqual({ agents: [], backgroundTasks: [] });
  });
});

describe("resolveSidebarThreadModelLabel", () => {
  it("uses the shell's selected model and provider effort label", () => {
    const thread = makeThreadFixture({
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "codex-alias",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
    const provider = {
      driver: ProviderDriverKind.make("codex"),
      models: [
        {
          slug: "gpt-6-codex",
          aliases: ["codex-alias"],
          name: "GPT-6 Codex",
          shortName: "Codex 6",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                type: "select",
                id: "reasoningEffort",
                label: "Effort",
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
      ],
    } satisfies Pick<ServerProvider, "driver" | "models">;

    expect(resolveSidebarThreadModelLabel(thread, provider)).toBe("Codex 6 · High");
  });

  it("follows the short model names switch", () => {
    const provider = {
      driver: ProviderDriverKind.make("claudeAgent"),
      models: [
        {
          slug: "claude-sonnet-5-5",
          name: "Claude Sonnet 5.5",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                type: "select",
                id: "effort",
                label: "Effort",
                options: [{ id: "medium", label: "Medium" }],
              },
            ],
          },
        },
      ],
    } satisfies Pick<ServerProvider, "driver" | "models">;
    const thread = makeThreadFixture({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-5-5",
        options: [{ id: "effort", value: "medium" }],
      },
    });

    expect(resolveSidebarThreadModelLabel(thread, provider, true)).toBe("Sonnet 5.5 · Medium");
    expect(resolveSidebarThreadModelLabel(thread, provider)).toBe("Claude Sonnet 5.5 · Medium");
  });
});

describe("background task metadata", () => {
  const startedAt = DateTime.makeUnsafe("2026-09-23T10:00:00.000Z");
  it("keeps task age and command kind without using legacy taskType to override kind", () => {
    expect(
      describeSidebarBackgroundWork(
        [
          {
            taskId: "shell",
            kind: "command",
            taskType: "local_agent",
            startedAt,
            commandKind: "python",
          },
          { taskId: "agent", kind: "subagent", taskType: "local_bash", startedAt },
        ],
        [],
      ).map((row) => [row.kind, row.startedAt]),
    ).toEqual([
      ["subagent", "2026-09-23T10:00:00.000Z"],
      ["command", "2026-09-23T10:00:00.000Z"],
    ]);
    expect(
      describeSidebarBackgroundWork(
        [{ taskId: "shell", kind: "command", startedAt, commandKind: "python" }],
        [],
      )[0],
    ).toMatchObject({ commandKind: "python" });
  });
  it("nests a shared-session shell once under its subagent and leaves servers out of waiting", () => {
    const tasks = [
      {
        taskId: "shell",
        kind: "command" as const,
        ownerThreadId: runningChild.id,
        commandKind: "server",
        startedAt,
      },
    ];
    const child = {
      ...runningChild,
      runtime: null,
      latestRun: null,
      pendingBackgroundTasks: [],
      hasPendingUserInput: false,
    };
    const parentRows = describeSidebarBackgroundWork(tasks, [child]);
    expect(parentRows.map((row) => row.taskId)).toEqual([child.id]);
    expect(parentRows[0]?.status).toBe("ready");
    const childTasks = pendingBackgroundWorkOfThread(child.id, [], tasks);
    expect(describeSidebarBackgroundWork(childTasks, [])[0]).toMatchObject({
      taskId: "shell",
      ownerThreadId: child.id,
      commandKind: "server",
    });
    expect(pendingBackgroundWorkOfThread(ThreadId.make("sibling"), [], tasks)).toEqual([]);
  });
  it("warns about a two-hour shell at the threshold", () => {
    const start = "2026-09-23T10:00:00.000Z";
    expect(msUntilPossiblyStuck(start, Date.parse("2026-09-23T11:30:00.000Z"))).toBe(
      30 * 60 * 1000,
    );
    expect(msUntilPossiblyStuck(start, Date.parse("2026-09-23T12:00:00.000Z"))).toBe(0);
    expect(msUntilPossiblyStuck(start, Date.parse("2026-09-24T12:00:00.000Z"))).toBe(0);
  });
});

describe("childWorktreeLabel", () => {
  const root = { worktreePath: null };
  const worktree = { branch: "feature/child", worktreePath: "/repo/.t3/worktrees/child" };

  it("names the branch of a child in its own worktree", () => {
    expect(childWorktreeLabel(worktree, root)).toBe("feature/child");
    expect(childWorktreeLabel(worktree, { worktreePath: "/repo/.t3/worktrees/parent" })).toBe(
      "feature/child",
    );
    expect(childWorktreeLabel(worktree, undefined)).toBe("feature/child");
    expect(childWorktreeLabel({ ...worktree, branch: null }, root)).toBe(
      "/repo/.t3/worktrees/child",
    );
  });

  it("marks nothing for a child sharing its parent's checkout", () => {
    expect(childWorktreeLabel(worktree, { worktreePath: worktree.worktreePath })).toBeNull();
    expect(childWorktreeLabel({ branch: "main", worktreePath: null }, root)).toBeNull();
    expect(childWorktreeLabel({ branch: "main", worktreePath: null }, undefined)).toBeNull();
  });
});
