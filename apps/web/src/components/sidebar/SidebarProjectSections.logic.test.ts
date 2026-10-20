import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import { describe, expect, it } from "vite-plus/test";

import {
  collectVisibleProjectThreadOrder,
  resolveProjectDrop,
  resolveSubsectionDrop,
  type ProjectDropSection,
  type ProjectThreadSection,
} from "./SidebarProjectSections.logic";

const sections: ProjectDropSection[] = [
  { id: "work", custom: true, projectKeys: ["a", "b", "c"] },
  { id: "apps", custom: true, projectKeys: ["x", "y"] },
  { id: "__ungrouped__", custom: false, projectKeys: ["u"] },
];

const drop = (projectKey: string, over: Parameters<typeof resolveProjectDrop>[0]["over"]) =>
  resolveProjectDrop({ projectKey, over, sections });

describe("resolveProjectDrop", () => {
  it("reorders within a section, landing below the row when moving down", () => {
    expect(drop("a", { type: "project", projectKey: "c" })).toEqual({
      sectionId: "work",
      projectKeys: ["b", "c", "a"],
      beforeKey: null,
    });
    expect(drop("c", { type: "project", projectKey: "a" })).toEqual({
      sectionId: "work",
      projectKeys: ["c", "a", "b"],
      beforeKey: "a",
    });
  });

  it("inserts above the hovered project of another section, or at its end", () => {
    expect(drop("a", { type: "project", projectKey: "y" })).toEqual({
      sectionId: "apps",
      projectKeys: ["x", "a", "y"],
      beforeKey: "y",
    });
    expect(drop("a", { type: "section", sectionId: "apps" })).toEqual({
      sectionId: "apps",
      projectKeys: ["x", "y", "a"],
      beforeKey: null,
    });
    expect(drop("u", { type: "project", projectKey: "x" })?.projectKeys).toEqual(["u", "x", "y"]);
  });

  it("moves into Other projects without a line, since that section has no order", () => {
    expect(drop("a", { type: "project", projectKey: "u" })).toEqual({
      sectionId: "__ungrouped__",
      projectKeys: null,
      beforeKey: undefined,
    });
  });

  it("is a no-op when the project would stay where it is", () => {
    expect(drop("a", { type: "project", projectKey: "a" })).toBeNull();
    expect(drop("c", { type: "section", sectionId: "work" })).toBeNull();
    expect(drop("u", { type: "section", sectionId: "__ungrouped__" })).toBeNull();
    expect(drop("a", { type: "section", sectionId: "missing" })).toBeNull();
  });
});

describe("collectVisibleProjectThreadOrder", () => {
  const environmentId = EnvironmentId.make("local");
  const thread = (id: string) => makeThreadFixture({ environmentId, id: ThreadId.make(id) });
  const key = (id: string) => scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
  it("follows visible subsection, project, and Other projects row order", () => {
    const projects = ["a", "b", "c", "other"].map((projectKey) => ({ projectKey }));
    const sections: ProjectThreadSection[] = [
      { id: "work", projectKeys: ["a", "b"], collapsed: false },
      { id: "client", parentId: "work", projectKeys: ["c"], collapsed: false },
    ];
    const threadsByProjectKey = new Map([
      ["a", [thread("a-1"), thread("a-2")]],
      ["b", [thread("b-1")]],
      ["c", [thread("c-1")]],
      ["other", [thread("other-1")]],
    ]);

    const collect = (
      options: {
        readonly sections?: readonly ProjectThreadSection[];
        readonly otherProjectsExpanded?: boolean;
        readonly expandedProjectKeys?: readonly string[];
      } = {},
    ) =>
      collectVisibleProjectThreadOrder({
        projects,
        sections: options.sections ?? sections,
        otherProjectsExpanded: options.otherProjectsExpanded ?? true,
        isProjectExpanded: (key) => options.expandedProjectKeys?.includes(key) ?? true,
        threadsByProjectKey,
        runningSubagentsByParentKey: new Map(),
        expandedByKey: {},
      });

    expect(collect()).toEqual(["c-1", "a-1", "a-2", "b-1", "other-1"].map(key));
    expect(collect({ expandedProjectKeys: ["a", "c", "other"] })).toEqual(
      ["c-1", "a-1", "a-2", "other-1"].map(key),
    );
    expect(
      collect({
        sections: sections.map((section) =>
          section.id === "work" ? { ...section, collapsed: true } : section,
        ),
        otherProjectsExpanded: false,
      }),
    ).toEqual([]);
  });

  it("includes expanded worktree workers before the next standalone thread", () => {
    const orchestrator = thread("orchestrator");
    const standalone = thread("standalone");
    const worker = (id: string, role: "implementor" | "reviewer", createdAt: string) => {
      const child = makeThreadFixture({
        environmentId,
        id: ThreadId.make(id),
        worktreePath: `/wt/${id}`,
        createdAt,
        lineage: {
          rootThreadId: orchestrator.id,
          parentThreadId: orchestrator.id,
          relationshipToParent: "subagent",
        },
      });
      return { ...child, source: { ...child.source, role } };
    };
    const input = {
      projects: [{ projectKey: "a" }],
      sections: [],
      otherProjectsExpanded: true,
      isProjectExpanded: () => true,
      threadsByProjectKey: new Map([["a", [orchestrator, standalone]]]),
      runningSubagentsByParentKey: new Map([
        [
          key("orchestrator"),
          [
            worker("reviewer", "reviewer", "2026-09-23T12:00:00.000Z"),
            worker("older", "implementor", "2026-09-23T09:00:00.000Z"),
            worker("newer", "implementor", "2026-09-23T11:00:00.000Z"),
          ],
        ],
      ]),
      expandedByKey: { [key("orchestrator")]: true },
    };
    expect(collectVisibleProjectThreadOrder(input)).toEqual(
      ["orchestrator", "newer", "older", "reviewer", "standalone"].map(key),
    );
    expect(
      collectVisibleProjectThreadOrder({
        ...input,
        expandedByKey: { [key("orchestrator")]: false },
      }),
    ).toEqual(["orchestrator", "standalone"].map(key));
  });
});

it("orders subsections alongside projects and keeps body drops as moves into the subsection", () => {
  const sections = [
    { id: "work", custom: true, projectKeys: ["a", "b"], childOrder: ["a", "section:idaes", "b"] },
    { id: "idaes", custom: true, parentId: "work", projectKeys: ["c"] },
  ];
  expect(
    resolveSubsectionDrop("idaes", { type: "project", projectKey: "a" }, sections)?.childOrder,
  ).toEqual(["section:idaes", "a", "b"]);
  expect(
    resolveSubsectionDrop("idaes", { type: "project", projectKey: "b" }, sections)?.childOrder,
  ).toEqual(["a", "b", "section:idaes"]);
  expect(
    resolveProjectDrop({
      projectKey: "a",
      over: { type: "section-header", sectionId: "idaes" },
      sections,
    })?.childOrder,
  ).toEqual(["section:idaes", "a", "b"]);
  expect(
    resolveProjectDrop({
      projectKey: "b",
      over: { type: "section-header", sectionId: "idaes" },
      sections,
    })?.childOrder,
  ).toEqual(["a", "b", "section:idaes"]);
  expect(
    resolveProjectDrop({ projectKey: "a", over: { type: "section", sectionId: "idaes" }, sections })
      ?.projectKeys,
  ).toEqual(["c", "a"]);
  const environmentId = EnvironmentId.make("local");
  const threadKey = (id: string) =>
    scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
  expect(
    collectVisibleProjectThreadOrder({
      projects: ["a", "b", "c"].map((projectKey) => ({ projectKey })),
      sections: sections.map((s) => ({ ...s, collapsed: false })),
      otherProjectsExpanded: true,
      isProjectExpanded: () => true,
      threadsByProjectKey: new Map(
        ["a", "b", "c"].map((key) => [
          key,
          [makeThreadFixture({ environmentId, id: ThreadId.make(key) })],
        ]),
      ),
      runningSubagentsByParentKey: new Map(),
      expandedByKey: {},
    }),
  ).toEqual(["a", "c", "b"].map(threadKey));
});
