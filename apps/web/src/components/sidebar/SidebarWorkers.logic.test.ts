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
  const key = scopedThreadKey(scopeThreadRef(parent.environmentId, parent.id));
  const indexed = indexSidebarWorkers([parent, { ...oldest!, archivedAt }, ...rest]);
  expect(indexed.running.size).toBe(0);
  const idle = indexed.children.get(key)!;
  expect(idle).toHaveLength(234);
  const page = sidebarWorkerPage(idle, SIDEBAR_WORKER_PAGE_SIZE, null);
  expect(page).toHaveLength(10);
  expect(page[0]).toBe(newest);
  expect(sidebarWorkerPage(idle, SIDEBAR_WORKER_PAGE_SIZE * 2, null)).toHaveLength(20);

  const restored = indexSidebarWorkers([parent, ...children]).children.get(key)!;
  expect(restored).toHaveLength(235);
  const revealed = sidebarWorkerPage(restored, SIDEBAR_WORKER_PAGE_SIZE, oldest!.id);
  expect(revealed).toHaveLength(10);
  expect(revealed).toContain(oldest);
});
