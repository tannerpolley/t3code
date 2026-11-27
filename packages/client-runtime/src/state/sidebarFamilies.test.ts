import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "./models.ts";
import {
  countSidebarAgentStates,
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
