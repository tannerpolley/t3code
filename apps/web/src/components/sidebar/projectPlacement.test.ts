import { EMPTY_SIDEBAR_LAYOUT, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  projectSectionRows,
  projectThreadPlacement,
  sortProjectThreads,
  type Layouts,
} from "./projectPlacement";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

it("keeps a manually moved thread between its neighbors through a send, settlement and reload", () => {
  const makeThread = (id: string, day: number) => ({
    id: ThreadId.make(id),
    environmentId: local,
    createdAt: `2026-11-0${day}T00:00:00.000Z`,
    latestUserAuthoredMessageAt: null as string | null,
    unsettledAt: null as string | null,
    activeOrderKey: null as string | null,
    settledOverride: null as "settled" | null,
  });
  const first = makeThread("first", 3);
  const second = makeThread("second", 2);
  const moved = makeThread("moved", 1);
  const threads = [first, second, moved];
  const ranks = projectThreadPlacement(threads, moved, second, new Map());
  expect(Object.keys(ranks ?? {})).toEqual(["moved"]);

  const layouts: Layouts = new Map([[local, { ...EMPTY_SIDEBAR_LAYOUT, threadRanks: ranks! }]]);
  const expectPlacement = (row: typeof moved, state: Layouts) => {
    expect(sortProjectThreads([second, row, first], state).map((thread) => thread.id)).toEqual([
      "first",
      "moved",
      "second",
    ]);
  };
  expectPlacement(moved, layouts);
  const sent = {
    ...moved,
    latestUserAuthoredMessageAt: "2026-11-25T00:00:00.000Z",
    unsettledAt: "2026-11-25T00:00:00.000Z",
    activeOrderKey: "b",
  };
  expectPlacement(sent, layouts);
  const settled = { ...sent, settledOverride: "settled" as const, activeOrderKey: null };
  expectPlacement(settled, layouts);
  const reloaded: Layouts = new Map(JSON.parse(JSON.stringify([...layouts])));
  expectPlacement({ ...settled }, reloaded);
  expectPlacement(
    moved,
    new Map([
      [...layouts][0]!,
      [remote, { ...EMPTY_SIDEBAR_LAYOUT, threadRanks: { [moved.id]: "z" } }],
    ]),
  );
});

it("preserves saved nested membership, order, and collapse without duplicating grouped folders", () => {
  const member = (projectId: string, environmentId = local) => ({
    projectId: ProjectId.make(projectId),
    environmentId,
  });
  const group = (projectId: string, refs = [member(projectId)]) => ({
    group: { projectKey: projectId, memberProjectRefs: refs },
  });
  const folders = [
    group("other"),
    group("inner"),
    group("grouped", [member("grouped"), member("worktree"), member("copy", remote)]),
  ];
  const layouts: Layouts = new Map([
    [
      local,
      {
        ...EMPTY_SIDEBAR_LAYOUT,
        sidebarProjectSections: [
          {
            id: "root",
            name: "Work",
            collapsed: false,
            projectKeys: ["worktree", "grouped"],
            childOrder: ["worktree", "section:inner"],
          },
          { id: "inner", name: "Work", collapsed: true, projectKeys: ["inner"], parentId: "root" },
          { id: "empty", name: "Empty", collapsed: false, projectKeys: [] },
        ],
      },
    ],
    [
      remote,
      {
        ...EMPTY_SIDEBAR_LAYOUT,
        sidebarProjectSections: [
          { id: "root", name: "Remote work", collapsed: false, projectKeys: ["copy"] },
        ],
      },
    ],
  ]);
  const read = (overrides: ReadonlyMap<string, boolean>) =>
    projectSectionRows(folders, layouts, overrides).map((row) =>
      row.kind === "section" ? row.id : row.folder.group.projectKey,
    );
  expect(read(new Map())).toEqual([
    "project-section:local:root",
    "grouped",
    "project-section:local:inner",
    "project-section:local:empty",
    "project-section:remote:root",
    "other",
  ]);
  expect(read(new Map([["project-section:local:inner", false]]))).toEqual([
    "project-section:local:root",
    "grouped",
    "project-section:local:inner",
    "inner",
    "project-section:local:empty",
    "project-section:remote:root",
    "other",
  ]);
  expect(read(new Map([["project-section:local:root", true]]))).toEqual([
    "project-section:local:root",
    "project-section:local:empty",
    "project-section:remote:root",
    "other",
  ]);
});
