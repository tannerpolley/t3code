import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "./models.ts";
import {
  countSidebarAgentStates,
  groupSidebarThreadsByProject,
  sidebarFamilyRows,
  indexSidebarChildren,
} from "./sidebarFamilies.ts";

const thread = (
  id: string,
  options: {
    project?: string;
    parent?: string;
    role?: EnvironmentThreadShell["delegatedRole"];
    createdAt?: string;
    archived?: boolean;
  } = {},
) =>
  ({
    environmentId: "env",
    id,
    projectId: options.project ?? "app",
    delegatedFrom: null,
    delegatedRole: options.role,
    createdAt: options.createdAt ?? "2026-11-27T00:00:00.000Z",
    archivedAt: options.archived ? "2026-11-27T01:00:00.000Z" : null,
    lineage: {
      parentThreadId: options.parent ?? null,
      relationshipToParent: options.parent ? "subagent" : null,
      sideChat: false,
      workflowStep: null,
    },
  }) as unknown as EnvironmentThreadShell;

it("keeps each orchestrator's role sections and each worker's native children together", () => {
  const first = thread("first");
  const second = thread("second");
  const owner = thread("owner");
  const threads = [
    first,
    second,
    owner,
    thread("review", { parent: "first", role: "review" }),
    thread("old-impl", { parent: "first", role: "implementation", createdAt: "2026-11-26" }),
    thread("new-impl", { parent: "first", role: "implementation", createdAt: "2026-11-27" }),
    thread("/root/native", { parent: "new-impl", role: "general" }),
    thread("archived", { parent: "first", role: "test", archived: true }),
    thread("other-impl", { parent: "second", role: "implementation" }),
  ];
  const children = indexSidebarChildren(threads);
  const roots = [first, second, owner];
  const expanded = new Map([
    ["env:first", true],
    ["env:second", true],
    ["env:new-impl", true],
  ]);
  const rows = (expansion = expanded, collapsedRole?: string) =>
    [...sidebarFamilyRows(roots, children, expansion, null, (key) => key !== collapsedRole)].map(
      ([key, items]) => [key, items.map((item) => [item.key, item.parentKey, item.depth])],
    );

  expect(rows()).toEqual([
    [
      "env:first",
      [
        ["env:first", undefined, 0],
        ["role:env:first:implementation", "env:first", 1],
        ["env:new-impl", "role:env:first:implementation", 2],
        ["env:/root/native", "env:new-impl", 3],
        ["env:old-impl", "role:env:first:implementation", 2],
        ["role:env:first:review", "env:first", 1],
        ["env:review", "role:env:first:review", 2],
      ],
    ],
    [
      "env:second",
      [
        ["env:second", undefined, 0],
        ["role:env:second:implementation", "env:second", 1],
        ["env:other-impl", "role:env:second:implementation", 2],
      ],
    ],
    ["env:owner", [["env:owner", undefined, 0]]],
  ]);
  expect(rows(new Map(expanded).set("env:first", false))[0]?.[1]).toEqual([
    ["env:first", undefined, 0],
  ]);
  expect(rows(expanded, "role:env:first:implementation")[1]).toEqual(rows()[1]);
});

it("can group linked agents when the parent's environment is absent", () => {
  const linked = {
    ...thread("linked", { role: "review" }),
    delegatedFrom: {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("parent"),
      title: "Parent",
    },
  };
  expect(indexSidebarChildren([linked]).get("remote:parent")).toEqual([linked]);
  expect(indexSidebarChildren([linked], new Set()).size).toBe(0);
});

describe("countSidebarAgentStates", () => {
  it("counts each state and skips threads with none", () => {
    const states = ["working", null, "attention", "working", "failed"] as const;
    expect(countSidebarAgentStates(states, (state) => state)).toEqual({
      working: 2,
      attention: 1,
      failed: 1,
    });
  });
});

describe("groupSidebarThreadsByProject", () => {
  it("puts each thread in its project's folder and drops empty projects unless kept", () => {
    const local = EnvironmentId.make("env");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const t3code = ProjectId.make("t3code");
    const t3codeRemote = ProjectId.make("t3code-remote");
    const fleet = ProjectId.make("fleet");
    const thread = (id: string, environmentId: EnvironmentId, projectId: ProjectId) => ({
      id,
      environmentId,
      projectId,
    });
    const groups = [
      {
        projectKey: "t3code",
        memberProjectRefs: [
          { environmentId: local, projectId: t3code },
          { environmentId: remoteEnvironmentId, projectId: t3codeRemote },
        ],
      },
      {
        projectKey: "fleet",
        memberProjectRefs: [{ environmentId: local, projectId: fleet }],
      },
      {
        projectKey: "notes",
        memberProjectRefs: [{ environmentId: local, projectId: ProjectId.make("notes") }],
      },
    ];

    const threads = [
      thread("a", local, t3code),
      thread("orphan", local, ProjectId.make("deleted")),
      thread("b", remoteEnvironmentId, t3codeRemote),
    ];
    const summarize = (keepEmpty: (group: (typeof groups)[number]) => boolean) =>
      groupSidebarThreadsByProject(groups, threads, keepEmpty).map((folder) => ({
        projectKey: folder.group.projectKey,
        threads: folder.threads.map((entry) => entry.id),
      }));

    expect(summarize(() => true)).toEqual([
      { projectKey: "t3code", threads: ["a", "b"] },
      { projectKey: "fleet", threads: [] },
      { projectKey: "notes", threads: [] },
    ]);
    expect(summarize(() => false)).toEqual([{ projectKey: "t3code", threads: ["a", "b"] }]);
    // A pinned project keeps its empty folder while other empty projects drop out.
    expect(summarize((group) => group.projectKey === "fleet")).toEqual([
      { projectKey: "t3code", threads: ["a", "b"] },
      { projectKey: "fleet", threads: [] },
    ]);
  });
});
