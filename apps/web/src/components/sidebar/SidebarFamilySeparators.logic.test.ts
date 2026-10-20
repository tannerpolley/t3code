import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { expect, it } from "vite-plus/test";
import { resolveLocationLeads } from "../Sidebar.logic";
import { describeSidebarBackgroundWork } from "./SidebarBackgroundWork.logic";
import { makeThreadFixture } from "../../test-fixtures";
import {
  collectDisplayedFamilyRows,
  resolveSidebarFamilySeparators,
  sidebarWorkSeparator,
  sidebarSeparatorStyle,
} from "./SidebarFamilySeparators.logic";

it("marks checkout changes within a family and solid boundaries around families", () => {
  const row = (key: string, familyKey = key, workspace: string | null = null) => ({
    key,
    familyKey,
    workspace,
  });
  const orchestrator = row("orchestrator");
  const worker = row("worker", orchestrator.key, "/wt/implementation");
  const helper = row("helper", orchestrator.key, worker.workspace);
  const sibling = row("sibling", orchestrator.key, "/wt/other");
  const reviewer = row("reviewer", orchestrator.key);
  const investigator = row("investigator", orchestrator.key);
  const otherRoot = row("other-root");
  const otherWorker = row("other-worker", otherRoot.key);
  expect([
    ...resolveSidebarFamilySeparators([
      row("before"),
      orchestrator,
      worker,
      helper,
      sibling,
      reviewer,
      investigator,
      otherRoot,
      otherWorker,
      row("after"),
      row("standalone"),
    ]),
  ]).toEqual([
    [orchestrator.key, "family"],
    [worker.key, "checkout change"],
    [sibling.key, "checkout change"],
    [reviewer.key, "checkout change"],
    [otherRoot.key, "family"],
    ["after", "family"],
  ]);
});

it("compares only displayed rows, following role order, nesting and expansion", () => {
  const environmentId = EnvironmentId.make("local");
  const parentId = ThreadId.make("orchestrator");
  const parent = makeThreadFixture({ environmentId, id: parentId });
  const worker = makeThreadFixture({
    environmentId,
    id: ThreadId.make("worker"),
    worktreePath: "/wt/worker",
    lineage: { rootThreadId: parentId, parentThreadId: parentId, relationshipToParent: "subagent" },
    pendingBackgroundTasks: [
      { taskId: "known-child", kind: "subagent", childThreadId: ThreadId.make("helper") },
      { taskId: "unknown-child", kind: "subagent" },
    ],
  });
  const helper = makeThreadFixture({
    environmentId,
    id: ThreadId.make("helper"),
    worktreePath: worker.worktreePath,
    lineage: {
      rootThreadId: parentId,
      parentThreadId: worker.id,
      relationshipToParent: "subagent",
    },
  });
  const reviewerFixture = makeThreadFixture({
    environmentId,
    id: ThreadId.make("reviewer"),
    lineage: worker.lineage,
  });
  const reviewer = {
    ...reviewerFixture,
    source: { ...reviewerFixture.source, role: "reviewer" as const },
  };
  const standalone = makeThreadFixture({ environmentId, id: ThreadId.make("standalone") });
  const key = (thread: typeof parent) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const input = {
    threads: [parent, standalone],
    runningSubagentsByParentKey: new Map([
      [key(parent), [reviewer, worker]],
      [key(worker), [helper]],
    ]),
    expandedByKey: {},
  };
  const rows = collectDisplayedFamilyRows(input);
  expect(rows.map((row) => row.key)).toEqual([
    key(parent),
    key(worker),
    key(helper),
    `${key(worker)}:task:unknown-child`,
    key(reviewer),
    key(standalone),
  ]);
  expect(rows[3]?.workspace).toBe(worker.worktreePath);
  expect([...resolveSidebarFamilySeparators(rows)]).toEqual([
    [key(worker), "checkout change"],
    [key(reviewer), "checkout change"],
    [key(standalone), "family"],
  ]);
  const collapsed = collectDisplayedFamilyRows({
    ...input,
    expandedByKey: { [key(parent)]: false },
  });
  expect(collapsed.map((row) => row.key)).toEqual([key(parent), key(standalone)]);
  expect([...resolveSidebarFamilySeparators(collapsed)]).toEqual([]);
  expect(
    collectDisplayedFamilyRows({
      ...input,
      expandedByKey: { [key(worker)]: false },
    }).map((row) => row.key),
  ).toEqual([key(parent), key(worker), key(reviewer), key(standalone)]);
});

it("puts a checkout's lead icon on its first displayed implementor", () => {
  const parent = makeThreadFixture({ id: ThreadId.make("orchestrator") });
  const worker = (id: string, createdAt: string) =>
    makeThreadFixture({
      environmentId: parent.environmentId,
      id: ThreadId.make(id),
      worktreePath: "/wt/shared",
      createdAt,
      lineage: {
        rootThreadId: parent.id,
        parentThreadId: parent.id,
        relationshipToParent: "subagent",
      },
    });
  const older = worker("older", "2026-09-23T09:00:00.000Z");
  const newer = worker("newer", "2026-09-23T11:00:00.000Z");
  const parentKey = scopedThreadKey(scopeThreadRef(parent.environmentId, parent.id));
  const leads = (expanded: boolean) =>
    resolveLocationLeads(
      collectDisplayedFamilyRows({
        threads: [parent],
        runningSubagentsByParentKey: new Map([[parentKey, [older, newer]]]),
        expandedByKey: { [parentKey]: expanded },
      }).flatMap(({ thread, topLevel }) => (thread === null ? [] : [{ thread, topLevel }])),
    );
  expect([...leads(true).values()].map((thread) => thread.id)).toEqual([parent.id, newer.id]);
  expect([...leads(false).values()].map((thread) => thread.id)).toEqual([parent.id]);
});

it("puts one dashed boundary after tasks or process groups and before the first agent", () => {
  const rows = [
    ...describeSidebarBackgroundWork(
      [
        { taskId: "run", kind: "command" },
        { taskId: "agent", kind: "subagent" },
        { taskId: "other", kind: "subagent" },
      ],
      [],
    ),
  ];
  const lines = rows.map((_, index) => sidebarWorkSeparator(undefined, rows, index, 1));
  expect(lines).toEqual([undefined, "processes block", undefined]);
  expect(sidebarSeparatorStyle(lines[1])).toBe("dashed");
  const agents = rows.filter((row) => row.kind === "subagent");
  expect(sidebarWorkSeparator("family", agents, 0, 2)).toBe("processes block");
  expect(sidebarWorkSeparator("checkout change", agents, 1, 2)).toBe("checkout change");
  expect(sidebarWorkSeparator(undefined, agents, 0, 0)).toBeUndefined();
});
