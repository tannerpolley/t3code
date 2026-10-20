import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { expect, it } from "vite-plus/test";
import { makeThreadFixture } from "../../test-fixtures";
import {
  collectDisplayedFamilyRows,
  resolveSidebarFamilySeparators,
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
    [orchestrator.key, "solid"],
    [worker.key, "dashed"],
    [sibling.key, "dashed"],
    [reviewer.key, "dashed"],
    [otherRoot.key, "solid"],
    ["after", "solid"],
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
    [key(worker), "dashed"],
    [key(reviewer), "dashed"],
    [key(standalone), "solid"],
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
