import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { SIDEBAR_WORKER_PAGE_SIZE, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { makeThreadFixture } from "~/test-fixtures";
import { indexSidebarWorkers, sidebarWorkerPage } from "./SidebarWorkers.logic";

it("keeps settled workers under their parent, bounds the initial page, and reveals an older worker", () => {
  const parent = makeThreadFixture({ id: ThreadId.make("parent") });
  const archivedAt = "2026-11-20T00:00:00Z";
  const children = Array.from({ length: 235 }, (_, index) =>
    makeThreadFixture({
      id: ThreadId.make(`worker-${String(index).padStart(3, "0")}`),
      lineage: {
        parentThreadId: parent.id,
        rootThreadId: parent.id,
        relationshipToParent: "subagent",
      },
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      settledOverride: "settled",
    }),
  );
  const [oldest, ...rest] = children;
  const newest = children.at(-1)!;
  const writer = { ...oldest!, source: { ...oldest!.source, role: "writer" as const } };
  const key = scopedThreadKey(scopeThreadRef(parent.environmentId, parent.id));
  const indexed = indexSidebarWorkers([parent, { ...writer, archivedAt }, ...rest]);
  expect(indexed.running.size).toBe(0);
  const idle = indexed.children.get(key)!;
  expect(idle).toHaveLength(234);
  const page = sidebarWorkerPage(idle, SIDEBAR_WORKER_PAGE_SIZE, null);
  expect(page).toHaveLength(10);
  expect(page[0]).toBe(newest);
  expect(sidebarWorkerPage(idle, SIDEBAR_WORKER_PAGE_SIZE * 2, null)).toHaveLength(20);

  const restored = indexSidebarWorkers([parent, writer, ...rest]).children.get(key)!;
  expect(restored).toHaveLength(235);
  const revealed = sidebarWorkerPage(restored, SIDEBAR_WORKER_PAGE_SIZE, writer.id);
  expect(revealed).toHaveLength(10);
  expect(revealed).toContain(writer);
});

it("nests a worker's own children under that worker, and lists them under the root once it is archived", () => {
  const root = makeThreadFixture({ id: ThreadId.make("root") });
  const subagentOf = (id: string, parent: ThreadId) =>
    makeThreadFixture({
      id: ThreadId.make(id),
      lineage: { parentThreadId: parent, rootThreadId: root.id, relationshipToParent: "subagent" },
    });
  const worker = subagentOf("worker", root.id);
  const idleReviewer = subagentOf("idle-reviewer", worker.id);
  const runningReviewer = {
    ...subagentOf("running-reviewer", worker.id),
    runtime: { ...idleReviewer.runtime!, status: "running" as const },
  };
  const keyOf = (thread: typeof root) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

  const indexed = indexSidebarWorkers([root, worker, idleReviewer, runningReviewer]);
  expect(indexed.children.get(keyOf(root))).toEqual([worker]);
  expect(new Set(indexed.children.get(keyOf(worker)))).toEqual(
    new Set([idleReviewer, runningReviewer]),
  );
  expect(indexed.running.has(keyOf(runningReviewer))).toBe(true);

  const archived = { ...worker, archivedAt: "2026-11-20T00:00:00Z" };
  const orphaned = indexSidebarWorkers([root, archived, idleReviewer]);
  expect(orphaned.children.get(keyOf(root))).toEqual([idleReviewer]);
  expect(orphaned.children.has(keyOf(worker))).toBe(false);
});
