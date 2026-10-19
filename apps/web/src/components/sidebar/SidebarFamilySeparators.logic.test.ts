import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { expect, it } from "vite-plus/test";
import { makeThreadFixture } from "../../test-fixtures";
import {
  collectDisplayedFamilyRows,
  resolveSidebarFamilySeparators,
} from "./SidebarFamilySeparators.logic";

it("marks only family and orchestrator boundaries in displayed row order", () => {
  const standalone = (key: string) => ({
    key,
    familyKey: key,
    parentKey: null,
    orchestrator: false,
    worker: false,
  });
  const orchestrator = { ...standalone("orchestrator"), orchestrator: true };
  const worker = {
    ...standalone("worker"),
    familyKey: orchestrator.key,
    parentKey: orchestrator.key,
    worker: true,
  };
  const sibling = { ...worker, key: "sibling" };
  const a = standalone("a");
  const b = standalone("b");
  for (const [rows, expected] of [
    [[a, b], []],
    [[orchestrator, worker, sibling], [[worker.key, "dashed"]]],
    [
      [a, orchestrator, worker, b],
      [
        [orchestrator.key, "solid"],
        [worker.key, "dashed"],
        [b.key, "solid"],
      ],
    ],
    [[worker, orchestrator], []],
    [[orchestrator, { ...worker, parentKey: "other" }], []],
    [[orchestrator, { ...worker, familyKey: "other" }], []],
  ] as const) {
    expect([...resolveSidebarFamilySeparators(rows)]).toEqual(expected);
  }
});

it("uses the same boundaries for nested and relocated workers, following expansion choices", () => {
  const environmentId = EnvironmentId.make("local");
  const parentId = ThreadId.make("orchestrator");
  const parentFixture = makeThreadFixture({ environmentId, id: parentId });
  const parent = {
    ...parentFixture,
    source: { ...parentFixture.source, role: "orchestrator" as const },
  };
  const workerFixture = makeThreadFixture({
    environmentId,
    id: ThreadId.make("worker"),
    lineage: { rootThreadId: parentId, parentThreadId: parentId, relationshipToParent: "subagent" },
  });
  const worker = {
    ...workerFixture,
    source: { ...workerFixture.source, role: "implementor" as const },
  };
  const standalone = makeThreadFixture({ environmentId, id: ThreadId.make("standalone") });
  const key = (thread: typeof parentFixture) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const input = {
    threads: [parent, standalone],
    runningSubagentsByParentKey: new Map([[key(parent), [worker]]]),
    expandedByKey: {},
  };
  const nested = collectDisplayedFamilyRows(input);
  const relocated = collectDisplayedFamilyRows({
    ...input,
    threads: [parent, worker, standalone],
    relocatedThreadKeys: new Set([key(worker)]),
  });
  expect(relocated).toEqual(nested);
  expect([...resolveSidebarFamilySeparators(nested)]).toEqual([
    [key(worker), "dashed"],
    [key(standalone), "solid"],
  ]);
  const collapsed = collectDisplayedFamilyRows({
    ...input,
    expandedByKey: { [key(parent)]: false },
  });
  expect(collapsed.map((row) => row.key)).toEqual([key(parent), key(standalone)]);
  expect([...resolveSidebarFamilySeparators(collapsed)]).toEqual([]);
  expect([
    ...resolveSidebarFamilySeparators(
      collectDisplayedFamilyRows({
        ...input,
        threads: [parent, worker],
        relocatedThreadKeys: new Set([key(worker)]),
        expandedByKey: { [key(parent)]: false },
      }),
    ),
  ]).toEqual([[key(worker), "dashed"]]);
});
