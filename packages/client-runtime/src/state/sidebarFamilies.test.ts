import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "./models.ts";
import {
  countSidebarAgentStates,
  groupSidebarThreadsByProject,
  sidebarProjectContents,
  indexSidebarChildren,
  sidebarRoleSections,
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

const folderOfProject = (child: EnvironmentThreadShell) =>
  child.projectId === "elsewhere" ? undefined : `folder:${child.projectId}`;

describe("sidebarRoleSections", () => {
  it("groups each project's live children by role, in role order, newest first", () => {
    const threads = [
      thread("main"),
      thread("docs-main", { project: "docs" }),
      thread("review", { parent: "main", role: "review" }),
      thread("old-impl", { parent: "main", role: "implementation", createdAt: "2026-11-26" }),
      thread("new-impl", { parent: "main", role: "implementation", createdAt: "2026-11-27" }),
      thread("general", { parent: "main", role: "general" }),
      thread("untagged", { parent: "new-impl" }),
      thread("archived", { parent: "main", role: "test", archived: true }),
      thread("writer", { parent: "docs-main", project: "docs", role: "writer" }),
      thread("unlisted", { parent: "main", project: "elsewhere", role: "design" }),
    ];

    const sections = sidebarRoleSections(indexSidebarChildren(threads, new Set()), folderOfProject);

    expect(
      [...sections].map(([folder, roles]) => [
        folder,
        roles.map((section) => [section.key, section.threads.map((child) => child.id)]),
      ]),
    ).toEqual([
      [
        "folder:app",
        [
          ["folder:app:implementation", ["new-impl", "old-impl"]],
          ["folder:app:review", ["review"]],
          ["folder:app:other", ["general", "untagged"]],
        ],
      ],
      ["folder:docs", [["folder:docs:writer", ["writer"]]]],
    ]);
  });
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
      groupSidebarThreadsByProject(groups, threads, new Map(), keepEmpty).map((folder) => ({
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

it("lists project threads before role sections and keeps folders containing only agents", () => {
  const main = thread("main");
  const settled = { ...thread("settled"), settledOverride: "settled" as const };
  const agent = thread("implementation", { parent: "main", role: "implementation" });
  const review = thread("review", { project: "docs", parent: "old", role: "review" });
  const folders = groupSidebarThreadsByProject(
    ["docs", "app"].map((projectKey) => ({
      projectKey,
      memberProjectRefs: [{ environmentId: main.environmentId, projectId: projectKey }],
    })),
    [main, settled],
    indexSidebarChildren([agent, review]),
    () => false,
  );

  expect(
    folders.map(({ group, threads, roleSections }) => [
      group.projectKey,
      ...sidebarProjectContents(threads, roleSections).flatMap(({ kind, rows }) =>
        kind === "threads"
          ? rows.map((row) => row.id)
          : rows.flatMap((section) => section.threads.map((row) => row.id)),
      ),
    ]),
  ).toEqual([
    ["docs", "review"],
    ["app", "main", "settled", "implementation"],
  ]);
});
