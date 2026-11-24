import {
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  type ServerProvider,
  type ThreadLinkedIssue,
  type ThreadRole,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  pendingBackgroundWorkOfThread,
  pullRequestWatchTaskId,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { describe, expect, it } from "vite-plus/test";

import { withNativeSidebarTaskOrigins } from "../../state/entities";
import { makeThreadFixture } from "../../test-fixtures";
import {
  childWorktreeLabel,
  sidebarRoleLabel,
  sidebarModelParts,
  sameSidebarSubagentTree,
  describeSidebarBackgroundWork,
  describeProjectSidebarWork,
  groupBackgroundWorkTaskRows,
  resolveSidebarThreadModelLabel,
  sidebarEffortGlyph,
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
  it("keeps a thread's own tasks first and roster-only subagents after known workers", () => {
    const nativeFixture = makeThreadFixture({
      id: ThreadId.make("native-child"),
      title: "Explore natively",
      createdAt: "2026-09-23T11:00:00.000Z",
      lineage: {
        rootThreadId: ThreadId.make("parent"),
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent",
      },
      runtime: runningChild.runtime,
    });
    const nativeChild = {
      ...nativeFixture,
      source: { ...nativeFixture.source, creationSource: "provider" as const },
    };
    const tasks = [
      {
        taskId: "linked-agent",
        description: "Review the diff",
        kind: "subagent",
        childThreadId: runningChild.id,
      },
      { taskId: "native-agent", kind: "subagent", childThreadId: nativeChild.id },
      { taskId: "native-roster", kind: "subagent", origin: "provider_native" },
      {
        taskId: "legacy-native-roster",
        kind: "subagent",
        providerInstanceId: runningChild.providerInstanceId,
      },
      {
        taskId: "turn-item:delegated-task:remote",
        kind: "subagent",
        providerInstanceId: runningChild.providerInstanceId,
      },
      { taskId: "command", description: "Run tests", kind: "command" },
      { taskId: "monitor", description: "Watch build", kind: "monitor" },
      { taskId: "unknown", kind: "background_task" },
    ] as const;
    const parent = makeThreadFixture({ pendingBackgroundTasks: tasks });
    const [marked] = withNativeSidebarTaskOrigins([parent, nativeChild, runningChild]);
    const rows = describeProjectSidebarWork(marked!.pendingBackgroundTasks, [runningChild]);

    expect(rows.map(({ taskId, kind }) => [taskId, kind])).toEqual([
      ["command", "command"],
      ["monitor", "monitor"],
      ["unknown", "background_task"],
      [runningChild.id, "subagent"],
      ["turn-item:delegated-task:remote", "subagent"],
    ]);
    expect(rows[3]).toMatchObject({
      label: "Review the diff",
      childThreadId: runningChild.id,
      startedAt: "2026-09-23T10:00:00.000Z",
      status: "working",
      child: runningChild,
    });
    expect(rows[4]).toMatchObject({ childThreadId: null, startedAt: null });
    const grandchild = makeThreadFixture({
      id: ThreadId.make("grandchild"),
      lineage: {
        rootThreadId: parent.id,
        parentThreadId: runningChild.id,
        relationshipToParent: "subagent",
      },
      runtime: runningChild.runtime,
    });
    expect(
      describeProjectSidebarWork(marked!.pendingBackgroundTasks, [runningChild, grandchild])
        .filter((row) => row.kind === "subagent")
        .map(({ taskId }) => taskId)
        .toSorted(),
    ).toEqual([runningChild.id, grandchild.id, "turn-item:delegated-task:remote"]);
    expect(describeSidebarBackgroundWork(tasks, [nativeChild, runningChild])).toContainEqual(
      expect.objectContaining({ childThreadId: nativeChild.id, child: nativeChild }),
    );
    expect(rows[0]).not.toHaveProperty("childThreadId");
  });

  it.each([
    { childThreadId: undefined, expected: [runningChild.id, "native-first", "native-second"] },
    { childThreadId: runningChild.id, expected: [runningChild.id, "native-first"] },
  ])(
    "keeps the first roster task when the second task's child ID is $childThreadId",
    ({ childThreadId, expected }) => {
      const rows = describeSidebarBackgroundWork(
        [
          { taskId: "native-first", kind: "subagent", origin: "provider_native" },
          {
            taskId: "native-second",
            kind: "subagent",
            origin: "provider_native",
            description: runningChild.title,
            ...(childThreadId === undefined ? {} : { childThreadId }),
          },
        ],
        [runningChild],
      );

      expect(rows.map((row) => row.taskId)).toEqual(expected);
    },
  );

  it("identifies each PR watch and shows work only while its checks are pending", () => {
    const watch = (number: number) => ({
      taskId: pullRequestWatchTaskId({ host: "github.com", repository: "acme/app", number }),
      kind: "monitor" as const,
    });
    const rows = describeSidebarBackgroundWork(
      [{ ...watch(579), awaited: true }, watch(580), { taskId: "native#581", kind: "monitor" }],
      [],
    );

    expect(rows[0]).toMatchObject({ pullRequestNumber: "579", status: "working" });
    expect(rows[1]).toMatchObject({ pullRequestNumber: "580", status: "ready" });
    expect(rows[2]).not.toHaveProperty("pullRequestNumber");
  });

  it("orders native and app-owned workers by effective role, then newest creation, independent of streaming activity", () => {
    const worker = (
      id: string,
      role: ThreadRole | undefined,
      createdAt: string,
      native = false,
    ) => ({
      ...runningChild,
      id: ThreadId.make(id),
      createdAt,
      source: {
        ...runningChild.source,
        role,
        creationSource: native ? ("provider" as const) : ("mcp" as const),
        lineage: { ...runningChild.source.lineage, relationshipToParent: "subagent" as const },
      },
    });
    const old = "2026-09-23T09:00:00.000Z";
    const recent = "2026-09-23T11:00:00.000Z";
    const children = [
      worker("designer", "designer", recent, true),
      worker("reviewer-first", "reviewer", recent),
      worker("reviewer-old", "reviewer", old),
      worker("implementor-old", "implementor", old),
      worker("other", "orchestrator", recent),
      worker("implementor-recent", undefined, recent, true),
      worker("reviewer-tied", "reviewer", recent),
      worker("reviewer-recent", "reviewer", recent),
    ];
    const expected = [
      "implementor-recent",
      "implementor-old",
      "reviewer-first",
      "reviewer-recent",
      "reviewer-tied",
      "reviewer-old",
      "designer",
      "other",
    ];
    expect(describeSidebarBackgroundWork([], children).map((row) => row.taskId)).toEqual(expected);
    const streamingChildren = children.map((child) => ({
      ...child,
      updatedAt: child.id === "implementor-old" ? "2026-09-23T12:00:00.000Z" : old,
    }));
    expect(describeSidebarBackgroundWork([], streamingChildren).map((row) => row.taskId)).toEqual(
      expected,
    );
    expect(children[0]?.id).toBe("designer");
    const sharedCheckout = children.map((child) => ({
      ...child,
      worktreePath: child.id === "reviewer-old" ? null : `/worktrees/${child.id}`,
    }));
    expect(
      describeSidebarBackgroundWork([], sharedCheckout, undefined, null).map((row) => row.taskId),
    ).toEqual(["reviewer-old", ...expected.filter((id) => id !== "reviewer-old")]);
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
    expect(describe("monitor")).toBe("ready");
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

    expect(resolveSidebarThreadModelLabel(thread, provider, true)).toBe("Codex 6 · High");
  });

  it("follows the short model names switch", () => {
    const provider = {
      driver: ProviderDriverKind.make("claudeAgent"),
      models: [
        {
          slug: "claude-sonnet-5-5",
          name: "Claude Sonnet 5.5",
          shortName: "Sonnet 5.5",
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
      ["command", "2026-09-23T10:00:00.000Z"],
      ["subagent", "2026-09-23T10:00:00.000Z"],
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

describe("sidebarRoleLabel", () => {
  it("titles every thread by the role it works as, issue workers included", () => {
    const top = { relationshipToParent: null } as const;
    const child = { relationshipToParent: "subagent" } as const;
    const issue = { number: 42, title: "Fix login" } as ThreadLinkedIssue;
    const title = (
      role: ThreadRole | undefined,
      lineage: { readonly relationshipToParent: "subagent" | "fork" | null },
      worktreePath: string | null = null,
      linkedIssue?: ThreadLinkedIssue,
    ) => {
      // A full shell carries its linked issue too; the title must not read it.
      const thread = {
        role,
        lineage,
        creationSource: "mcp" as const,
        branch: worktreePath === null ? null : "t3/x",
        worktreePath,
        linkedIssue,
      };
      return sidebarRoleLabel(thread);
    };
    // The issue shows as its own badge, so it never replaces the role.
    expect(title("implementor", child, "/wt/x", issue)).toBe("Implementor");
    expect(title("reviewer", child)).toBe("Reviewer");
    // A role-less thread the user starts outside a worktree, or forks there, is an Orchestrator.
    expect(title(undefined, top)).toBe("Orchestrator");
    expect(title(undefined, { relationshipToParent: "fork" })).toBe("Orchestrator");
    // Role-less child agents and threads in worktrees are Implementors; a stored role still wins.
    expect(title(undefined, child)).toBe("Implementor");
    expect(title(undefined, top, "/wt/x")).toBe("Implementor");
    expect(title("reviewer", child, "/wt/x")).toBe("Reviewer");
    expect(
      sidebarRoleLabel({
        role: undefined,
        creationSource: "provider",
        lineage: child,
        branch: null,
        worktreePath: null,
      }),
    ).toBe("Worker");
  });
});

describe("sidebarModelParts", () => {
  it.each([
    ["Opus 5.5", { name: "Opus", version: "5.5" }],
    ["6.1 Sol", { name: "Sol", version: "6.1" }],
    ["GPT-5.3 Codex", { name: "GPT", version: "5.3" }],
    ["Flash 3.8 (High)", { name: "Flash", version: "3.8" }],
    ["Default", { name: "Default" }],
  ])("splits %s into its name, then its version", (label, parts) => {
    expect(sidebarModelParts(label)).toEqual(parts);
  });
});

describe("childWorktreeLabel", () => {
  const root = { worktreePath: null };
  const worktree = { worktreePath: "/repo/.t3/worktrees/t3code-child-1a2b" };

  it("names the folder of a child in its own worktree", () => {
    expect(childWorktreeLabel(worktree, root)).toBe("t3code-child-1a2b");
    expect(childWorktreeLabel(worktree, { worktreePath: "/repo/.t3/worktrees/parent" })).toBe(
      "t3code-child-1a2b",
    );
    expect(childWorktreeLabel({ worktreePath: "/repo/.t3/worktrees/child/" }, undefined)).toBe(
      "child",
    );
  });

  it("marks nothing for a child sharing its parent's checkout", () => {
    expect(childWorktreeLabel(worktree, { worktreePath: worktree.worktreePath })).toBeNull();
    expect(childWorktreeLabel({ worktreePath: null }, root)).toBeNull();
    expect(childWorktreeLabel({ worktreePath: null }, undefined)).toBeNull();
  });
});

describe("sidebar subtree invalidation", () => {
  it("ignores unrelated updates but notices a changed grandchild", () => {
    const childKey = `${runningChild.environmentId}:${runningChild.id}`;
    const grandchild = makeThreadFixture({ id: ThreadId.make("grandchild") });
    const before = new Map([
      ["root", [runningChild]],
      [childKey, [grandchild]],
    ]);
    const after = new Map([...before, ["unrelated", [makeThreadFixture()]]]);
    expect(sameSidebarSubagentTree("root", before, after)).toBe(true);
    after.set(childKey, [{ ...grandchild, title: "New work" }]);
    expect(sameSidebarSubagentTree("root", before, after)).toBe(false);
  });
});

describe("sidebarEffortGlyph", () => {
  it("draws the composer's bars for the model's own levels, filling all of them for Max", () => {
    const provider = {
      models: [
        {
          slug: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                type: "select",
                id: "effort",
                label: "Effort",
                options: ["Low", "Medium", "High", "Extra High", "Max"].map((label) => ({
                  id: label === "Extra High" ? "xhigh" : label.toLowerCase(),
                  label,
                  ...(label === "High" ? { isDefault: true } : {}),
                })),
              },
            ],
          },
        },
      ],
    } satisfies Pick<ServerProvider, "models">;
    const opus = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
    const glyph = (effort: string) =>
      sidebarEffortGlyph(provider, { ...opus, options: [{ id: "effort", value: effort }] });
    expect(sidebarEffortGlyph(provider, opus)).toEqual({ count: 5, filled: 3, label: "High" });
    expect(glyph("high")).toEqual({ count: 5, filled: 3, label: "High" });
    expect(glyph("max")).toEqual({ count: 5, filled: 5, label: "Max" });
    // An agent's reported effort, by id or label, wins over the selection.
    expect(sidebarEffortGlyph(provider, opus, "xhigh")).toEqual({
      count: 5,
      filled: 4,
      label: "Extra High",
    });
    expect(sidebarEffortGlyph(provider, opus, "Low")?.filled).toBe(1);
  });
});
