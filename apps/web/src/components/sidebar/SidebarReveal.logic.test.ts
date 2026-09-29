import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarReveal, type RevealSection, type RevealThread } from "./SidebarReveal.logic";

const threads: Record<string, RevealThread> = {
  main: { parentKey: null, projectKey: "app", archived: false },
  sub: { parentKey: "main", projectKey: "app", archived: false },
  subsub: { parentKey: "sub", projectKey: "app", archived: false },
  loose: { parentKey: null, projectKey: "loose-project", archived: false },
  gone: { parentKey: null, projectKey: "app", archived: true },
  orphan: { parentKey: "missing", projectKey: "app", archived: false },
};
const sections: RevealSection[] = [
  { id: "work", collapsed: true, projectKeys: [] },
  { id: "apps", parentId: "work", collapsed: true, projectKeys: ["app"] },
];

const reveal = (
  threadKey: string,
  overrides: Partial<Parameters<typeof resolveSidebarReveal>[0]> = {},
) =>
  resolveSidebarReveal({
    threadKey,
    getThread: (key) => threads[key],
    sections,
    otherProjectsExpanded: true,
    isProjectExpanded: () => false,
    ...overrides,
  });

describe("resolveSidebarReveal", () => {
  it("reveals a nested subagent through its top-level parent's row", () => {
    expect(reveal("subsub")).toEqual({
      rowKey: "main",
      projectKey: "app",
      expandSectionIds: ["apps", "work"],
      expandOtherProjects: false,
      expandProject: true,
    });
  });

  it("opens the collapsed subsection and its parent section", () => {
    expect(reveal("main")?.expandSectionIds).toEqual(["apps", "work"]);
    expect(
      reveal("main", { sections: sections.map((s) => ({ ...s, collapsed: s.id === "apps" })) })
        ?.expandSectionIds,
    ).toEqual(["apps"]);
  });

  it("opens Other projects for a project in no section", () => {
    expect(reveal("loose", { otherProjectsExpanded: false })).toMatchObject({
      expandSectionIds: [],
      expandOtherProjects: true,
    });
  });

  it("has nothing to open for a thread that is already visible", () => {
    expect(
      reveal("main", {
        sections: sections.map((section) => ({ ...section, collapsed: false })),
        isProjectExpanded: () => true,
      }),
    ).toEqual({
      rowKey: "main",
      projectKey: "app",
      expandSectionIds: [],
      expandOtherProjects: false,
      expandProject: false,
    });
  });

  it("has no reveal for unknown, archived or parentless-orphan threads", () => {
    expect(reveal("nope")).toBeNull();
    expect(reveal("gone")).toBeNull();
    expect(reveal("orphan")).toBeNull();
  });
});
