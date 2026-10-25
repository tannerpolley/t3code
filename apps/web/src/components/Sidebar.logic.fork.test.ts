import { RuntimeRequestId } from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";

import { describe, expect, it } from "vite-plus/test";

import {
  filterSidebarV2VisibleThreads,
  formatStoppedThreadDuration,
  flattenRunningSubagents,
  groupRunningSubagentsByParent,
  resolveLocationLeads,
  withChildNeeds,
  resolveThreadStatusMark,
  isSidebarThreadWorking,
  resolveSidebarThreadStatus,
} from "./Sidebar.logic";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";

import { type Thread } from "../types";
import { makeThreadFixture } from "../test-fixtures";

const localEnvironmentId = EnvironmentId.make("environment-local");

function makeLatestRun(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): NonNullable<Thread["latestRun"]> {
  return {
    runId: "turn-1" as never,
    status: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt:
      overrides?.startedAt !== undefined ? overrides.startedAt : "2026-03-09T10:00:00.000Z",
    completedAt:
      overrides?.completedAt !== undefined ? overrides.completedAt : "2026-03-09T10:05:00.000Z",
  };
}

describe("resolveSidebarThreadStatus", () => {
  const runtime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };

  const idle = { hasPendingApprovals: false, hasPendingUserInput: false, runtime: null };

  it("reports waiting on background work below approval, input, and a failed turn", () => {
    const backgroundWait = { ...runtime, status: "idle" as const };
    const latestRun = (status: "completed" | "failed") => ({
      runId: "run-1" as never,
      status,
      requestedAt: null,
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
    });
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: backgroundWait,
        latestRun: latestRun("completed"),
      }),
    ).toBe("waiting");
    expect(
      resolveSidebarThreadStatus({ ...idle, hasPendingApprovals: true, runtime: backgroundWait }),
    ).toBe("approval");
    expect(
      resolveSidebarThreadStatus({ ...idle, hasPendingUserInput: true, runtime: backgroundWait }),
    ).toBe("input");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: backgroundWait,
        latestRun: latestRun("failed"),
      }),
    ).toBe("failed");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...backgroundWait, lastErrorClass: "usage_limit" as const },
        latestRun: latestRun("failed"),
      }),
    ).toBe("limited");
  });
});

describe("formatStoppedThreadDuration", () => {
  const startedAt = DateTime.makeUnsafe("2026-09-21T12:00:00.000Z");
  const completedAt = DateTime.makeUnsafe("2026-09-21T12:01:05.000Z");
  const base = {
    ...makeThreadFixture().source,
    latestRunId: RunId.make("last-run"),
    latestRunStartedAt: startedAt,
    latestRunCompletedAt: completedAt,
    updatedAt: DateTime.makeUnsafe("2026-09-23T12:00:00.000Z"),
  };

  it("freezes the completed run's duration rather than its age", () => {
    expect(formatStoppedThreadDuration(presentThreadShell(localEnvironmentId, base))).toBe(
      "01m 05s",
    );
  });

  it.each([
    ["no run", { latestRunId: null }],
    ["no start", { latestRunStartedAt: null }],
    ["no finish", { latestRunCompletedAt: null }],
    ["neither time", { latestRunStartedAt: null, latestRunCompletedAt: null }],
    ["older server without a finish field", { latestRunCompletedAt: undefined }],
  ])("shows nothing for %s", (_, missing) => {
    const thread = presentThreadShell(localEnvironmentId, { ...base, ...missing });
    expect(formatStoppedThreadDuration(thread)).toBeNull();
  });
});

describe("groupRunningSubagentsByParent", () => {
  const child = (
    id: string,
    overrides: {
      status?: "running" | "completed" | "idle";
      fork?: boolean;
      asking?: boolean;
      backgroundWork?: boolean;
      pendingTaskFor?: string;
      native?: boolean;
    } = {},
  ) => ({
    id: ThreadId.make(id),
    environmentId: localEnvironmentId,
    source: { creationSource: overrides.native ? ("provider" as const) : ("mcp" as const) },
    pendingBackgroundTasks: [
      ...(overrides.backgroundWork
        ? [{ taskId: "bash-1", kind: "monitor" as const, awaited: true as const }]
        : []),
      ...(overrides.pendingTaskFor
        ? [
            {
              taskId: "item-1",
              kind: "subagent" as const,
              childThreadId: ThreadId.make(overrides.pendingTaskFor),
            },
          ]
        : []),
    ],
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: overrides.asking ?? false,
    lineage: {
      parentThreadId: ThreadId.make("parent"),
      relationshipToParent: overrides.fork ? ("fork" as const) : ("subagent" as const),
      rootThreadId: ThreadId.make("parent"),
    },
    runtime: {
      status: overrides.status ?? "running",
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: null,
      lastError: null,
      updatedAt: "2026-09-23T10:00:00.000Z",
    },
  });

  it("lists a child held by an owned monitor on another thread's roster", () => {
    const finished = child("monitor-owner", { status: "completed" });
    const parent = {
      ...child("parent"),
      pendingBackgroundTasks: [
        {
          taskId: "monitor",
          kind: "monitor" as const,
          awaited: true as const,
          ownerThreadId: finished.id,
        },
      ],
    };
    expect(
      [...groupRunningSubagentsByParent([finished, parent]).values()]
        .flat()
        .map((thread) => thread.id),
    ).toContain(finished.id);
    const command = {
      ...parent,
      pendingBackgroundTasks: [
        { taskId: "command", kind: "command" as const, ownerThreadId: finished.id },
      ],
    };
    expect(
      [...groupRunningSubagentsByParent([finished, command]).values()]
        .flat()
        .map((thread) => thread.id),
    ).not.toContain(finished.id);
  });

  it("keeps only running subagent children, keyed by their parent", () => {
    const grouped = groupRunningSubagentsByParent([
      child("running"),
      child("finished", { status: "completed" }),
      child("idle", { status: "idle" }),
      child("waiting-on-own-work", { status: "idle", backgroundWork: true }),
      // Its turn ended, but a pending task still names it.
      child("result-pending", { status: "completed" }),
      child("sibling-holding-the-task", { pendingTaskFor: "result-pending" }),
      child("fork", { fork: true }),
      child("asking", { status: "completed", asking: true }),
    ]);
    expect([...grouped.keys()]).toEqual([
      scopedThreadKey(scopeThreadRef(localEnvironmentId, ThreadId.make("parent"))),
    ]);
    expect([...grouped.values()].flat().map((thread) => thread.id)).toEqual([
      "running",
      "waiting-on-own-work",
      "result-pending",
      "sibling-holding-the-task",
      "asking",
    ]);
  });

  it("lists a running grandchild only under its listed parent, carrying its request up", () => {
    const middle = child("middle");
    const leaf = {
      ...child("leaf", { asking: true }),
      lineage: { ...middle.lineage, parentThreadId: middle.id },
    };
    const grouped = groupRunningSubagentsByParent([middle, leaf]);
    const listedUnder = (id: string) =>
      grouped.get(scopedThreadKey(scopeThreadRef(localEnvironmentId, ThreadId.make(id)))) ?? [];
    expect(listedUnder("parent").map((thread) => thread.id)).toEqual(["middle"]);
    expect(listedUnder("middle").map((thread) => thread.id)).toEqual(["leaf"]);
    expect(listedUnder("parent")[0]!.hasPendingUserInput).toBe(true);
    // The flat list shows the grandchild once, right after its parent.
    expect(
      flattenRunningSubagents(listedUnder("parent"), grouped).map((thread) => thread.id),
    ).toEqual(["middle", "leaf"]);
  });

  it("leaves worker ordering to the background work rows", () => {
    const grouped = groupRunningSubagentsByParent([
      child("native-early", { native: true }),
      child("implementor"),
      child("native-late", { native: true }),
    ]);
    expect([...grouped.values()].flat().map((thread) => thread.id)).toEqual([
      "native-early",
      "implementor",
      "native-late",
    ]);
  });

  it("lists a subagent of a visible fork only under the fork's own row", () => {
    const fork = child("fork", { fork: true, status: "idle" });
    const leaf = {
      ...child("leaf"),
      lineage: {
        ...fork.lineage,
        relationshipToParent: "subagent" as const,
        parentThreadId: fork.id,
      },
    };
    const grouped = groupRunningSubagentsByParent([fork, leaf]);
    const listedUnder = (id: string) =>
      grouped.get(scopedThreadKey(scopeThreadRef(localEnvironmentId, ThreadId.make(id)))) ?? [];
    expect(listedUnder("fork").map((thread) => thread.id)).toEqual(["leaf"]);
    expect(listedUnder("parent")).toEqual([]);
  });
});

describe("thread locations", () => {
  const at = (
    id: string,
    worktreePath: string | null,
    role?: "orchestrator" | "implementor" | "reviewer",
    relationshipToParent: "subagent" | null = null,
    creationSource: "web" | "provider" = "web",
  ) => ({
    id: ThreadId.make(id),
    environmentId: localEnvironmentId,
    worktreePath,
    source: {
      role,
      branch: worktreePath === null ? null : `t3/${id}`,
      worktreePath,
      creationSource,
      lineage: { parentThreadId: null, relationshipToParent, rootThreadId: ThreadId.make(id) },
    },
  });
  it("leads the main checkout with its orchestrator and a worktree with its implementor", () => {
    const leads = resolveLocationLeads([
      // A role-less child is an implementor; a role-less top-level thread there is the orchestrator.
      { thread: at("helper", null, undefined, "subagent"), topLevel: false },
      { thread: at("main", null), topLevel: true },
      { thread: at("orchestrator", null, "orchestrator"), topLevel: true },
      // A role-less agent in a worktree counts as its implementor; a reviewer there does not lead,
      // nor does a native subagent, whose location cell holds its robot mark.
      { thread: at("native", "/wt/x", "implementor", "subagent", "provider"), topLevel: false },
      { thread: at("reviewer", "/wt/x", "reviewer"), topLevel: true },
      { thread: at("worker", "/wt/x"), topLevel: false },
      { thread: at("implementor", "/wt/x", "implementor"), topLevel: false },
    ]);
    expect([...leads.values()].map((thread) => thread.id)).toEqual(["main", "worker"]);
  });
});

describe("withChildNeeds", () => {
  it.each(["archived", "missing"] as const)(
    "keeps an owner-visible request in the sidebar when its parent is %s",
    (state) => {
      const source = makeThreadFixture().source;
      const parent = {
        ...source,
        status: "running" as const,
        archivedAt: state === "archived" ? source.createdAt : null,
      };
      const childSource = {
        ...source,
        id: ThreadId.make("orphan-child"),
        lineage: {
          rootThreadId: parent.id,
          parentThreadId: parent.id,
          relationshipToParent: "subagent" as const,
        },
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("orphan-question"),
          kind: "user_input" as const,
          createdAt: source.createdAt,
          routedTo: parent.id,
        },
      };
      const child = presentThreadShell(
        localEnvironmentId,
        childSource,
        null,
        state === "missing" ? null : parent,
      );
      const parentRow = presentThreadShell(localEnvironmentId, parent);
      // A parent in another environment cannot absorb this request's attention.
      const remoteParent = presentThreadShell(EnvironmentId.make("remote"), {
        ...parent,
        archivedAt: null,
      });
      const rows = filterSidebarV2VisibleThreads(
        state === "missing" ? [remoteParent, child] : [remoteParent, parentRow, child],
        null,
      );
      expect(rows.map((thread) => thread.id)).toContain(child.id);
      expect(resolveSidebarThreadStatus(child)).toBe("input");
      expect(isSidebarThreadWorking(child)).toBe(false);
    },
  );

  it("shows nested owner requests on the root row and keeps them out of Working", () => {
    const source = makeThreadFixture().source;
    const root = presentThreadShell(localEnvironmentId, { ...source, status: "running" });
    const middle = {
      ...source,
      id: ThreadId.make("middle"),
      status: "completed" as const,
      lineage: {
        rootThreadId: root.id,
        parentThreadId: root.id,
        relationshipToParent: "subagent" as const,
      },
    };
    const leafSource = {
      ...source,
      id: ThreadId.make("leaf"),
      status: "running" as const,
      lineage: {
        rootThreadId: root.id,
        parentThreadId: middle.id,
        relationshipToParent: "subagent" as const,
      },
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("nested-question"),
        kind: "user_input" as const,
        createdAt: source.createdAt,
        routedTo: middle.id,
      },
    };
    const leaf = presentThreadShell(localEnvironmentId, leafSource, null, middle);
    const children = groupRunningSubagentsByParent([
      root,
      presentThreadShell(localEnvironmentId, middle),
      leaf,
    ]).get(scopedThreadKey(scopeThreadRef(localEnvironmentId, root.id)))!;
    expect(withChildNeeds(resolveSidebarThreadStatus(root), children)).toBe("input");
    expect(
      isSidebarThreadWorking({
        ...root,
        hasPendingUserInput: children.some((child) => child.hasPendingUserInput),
      }),
    ).toBe(false);
    const handling = presentThreadShell(localEnvironmentId, leafSource, null, {
      ...middle,
      status: "running",
    });
    const hidden = groupRunningSubagentsByParent([root, handling]).get(
      scopedThreadKey(scopeThreadRef(localEnvironmentId, root.id)),
    )!;
    expect(withChildNeeds(resolveSidebarThreadStatus(root), hidden)).toBe("working");
  });

  it("moves a routed child request from Working to owner attention when its parent stops", () => {
    const source = makeThreadFixture().source;
    const parent = { ...source, status: "running" as const };
    const child = {
      ...source,
      status: "running" as const,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("sidebar-routed-question"),
        kind: "user_input" as const,
        createdAt: source.createdAt,
        routedTo: parent.id,
      },
    };
    const working = presentThreadShell(localEnvironmentId, child, null, parent);
    expect(withChildNeeds("working", [working])).toBe("working");
    expect(isSidebarThreadWorking(working)).toBe(true);
    const visible = presentThreadShell(localEnvironmentId, child, null, {
      ...parent,
      status: "interrupted",
      activeRunId: null,
      activityRunStatus: null,
    });
    expect(withChildNeeds("ready", [visible])).toBe("input");
    expect(isSidebarThreadWorking(visible)).toBe(false);
  });

  const idle = { hasPendingApprovals: false, hasPendingUserInput: false };
  it("shows a child's question on a working or ready parent, but keeps the parent's own urgent state", () => {
    const asking = { hasPendingApprovals: false, hasPendingUserInput: true };
    expect(withChildNeeds("working", [idle, asking])).toBe("input");
    expect(
      withChildNeeds("ready", [{ hasPendingApprovals: true, hasPendingUserInput: false }]),
    ).toBe("approval");
    expect(withChildNeeds("failed", [asking])).toBe("failed");
    expect(withChildNeeds("waiting", [idle])).toBe("waiting");
  });

  it("keeps a settled parent waiting while a listed child still works", () => {
    expect(withChildNeeds("ready", [idle])).toBe("waiting");
    expect(withChildNeeds("ready", [])).toBe("ready");
  });
});

it("does not list a finished child for another environment's task or a running command", () => {
  const parent = makeThreadFixture({ environmentId: localEnvironmentId });
  const foreignEnvironment = EnvironmentId.make("foreign");
  const child = {
    ...parent,
    id: ThreadId.make("child"),
    runtime: null,
    pendingBackgroundTasks: [{ taskId: "server", kind: "command" as const }],
    lineage: {
      parentThreadId: parent.id,
      rootThreadId: parent.id,
      relationshipToParent: "subagent" as const,
    },
  };
  const foreign = {
    ...parent,
    environmentId: foreignEnvironment,
    pendingBackgroundTasks: [
      { taskId: "agent", kind: "subagent" as const, childThreadId: child.id },
    ],
  };
  expect([...groupRunningSubagentsByParent([child, foreign]).values()].flat()).toEqual([]);
});

describe("resolveThreadStatusMark", () => {
  const thread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestRun: makeLatestRun(),
    runtime: null,
  };

  it("shows done until the finished thread is opened, from either visit record", () => {
    expect(
      resolveThreadStatusMark({ ...thread, lastVisitedAt: "2026-03-09T10:04:00.000Z" }, undefined),
    ).toBe("done");
    expect(
      resolveThreadStatusMark({ ...thread, lastVisitedAt: "2026-03-09T10:06:00.000Z" }, undefined),
    ).toBe("ready");
    // Servers without visit tracking fall back to this browser's visit.
    expect(resolveThreadStatusMark(thread, "2026-03-09T10:06:00.000Z")).toBe("ready");
  });

  it("keeps a thread waiting on background work amber, not done", () => {
    expect(
      resolveThreadStatusMark(
        {
          ...thread,
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          runtime: {
            status: "idle",
            activeRunId: null,
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            providerName: null,
            lastError: null,
            updatedAt: "2026-03-09T10:05:00.000Z",
          },
        },
        undefined,
      ),
    ).toBe("waiting");
  });
});
