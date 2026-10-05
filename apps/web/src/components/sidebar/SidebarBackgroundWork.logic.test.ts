import {
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import {
  describeSidebarBackgroundWork,
  groupBackgroundWorkTaskRows,
  resolveSidebarThreadModelLabel,
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
      pendingBackgroundTasks: [{ taskId: "monitor", kind: "monitor" }],
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
});
