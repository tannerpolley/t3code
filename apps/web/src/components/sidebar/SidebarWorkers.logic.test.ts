import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { SIDEBAR_WORKER_PAGE_SIZE, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { makeThreadFixture } from "~/test-fixtures";
import {
  indexSidebarWorkers,
  remainingSidebarWorkers,
  sidebarWorkerPage,
  sidebarWorkerRecedes,
} from "./SidebarWorkers.logic";

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

  const firstPage = {
    snapshotSequence: 1,
    threads: [],
    nextWorkerPage: { threadId: newest.id, createdAt: newest.createdAt },
    remainingWorkers: 2,
  };
  expect(remainingSidebarWorkers([newest, writer], [], 10, firstPage)).toBe(1);
  expect(
    remainingSidebarWorkers([newest, writer], [], 10, { ...firstPage, remainingWorkers: 1 }),
  ).toBe(0);
  expect(remainingSidebarWorkers([newest], [writer], 10, firstPage)).toBe(1);
  expect(remainingSidebarWorkers([newest, writer], [], 1, firstPage)).toBe(2);
  expect(
    remainingSidebarWorkers([newest], [{ ...writer, createdAt: newest.createdAt }], 10, firstPage),
  ).toBe(1);
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
  const nativeChild = subagentOf("thread:subagent:native-review", worker.id);
  const native = {
    ...nativeChild,
    runtime: runningReviewer.runtime,
    source: { ...nativeChild.source, creationSource: "provider" as const },
  };
  const keyOf = (thread: typeof root) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

  const indexed = indexSidebarWorkers([root, worker, idleReviewer, runningReviewer, native]);
  expect(indexed.children.get(keyOf(root))).toEqual([worker]);
  expect(
    indexed.children
      .get(keyOf(worker))
      ?.map(({ id }) => id)
      .toSorted(),
  ).toEqual([idleReviewer.id, runningReviewer.id].toSorted());
  expect(indexed.running.has(keyOf(runningReviewer))).toBe(true);
  expect(indexed.running.has(keyOf(native))).toBe(false);

  const archived = { ...worker, archivedAt: "2026-11-20T00:00:00Z" };
  const orphaned = indexSidebarWorkers([root, archived, idleReviewer]);
  expect(orphaned.children.get(keyOf(root))).toEqual([idleReviewer]);
  expect(orphaned.children.has(keyOf(worker))).toBe(false);
});

it("dims only finished, disposable workers", () => {
  const reviewer = makeThreadFixture({
    lineage: {
      parentThreadId: ThreadId.make("parent"),
      rootThreadId: ThreadId.make("parent"),
      relationshipToParent: "subagent",
    },
  });
  const linkedIssue = {
    host: "github.com",
    repository: "owner/repo",
    repositoryId: "repo",
    number: 43,
    id: "43",
    nodeId: "I_43",
    title: "Fix",
    url: "https://github.com/owner/repo/issues/43",
  };
  const issueWorker = { ...reviewer, source: { ...reviewer.source, linkedIssue } };
  const writer = { ...reviewer, source: { ...reviewer.source, role: "writer" as const } };
  const pinned = { ...reviewer, pinnedAt: "2026-11-20T00:00:00Z" };
  const nativeWriter = {
    ...writer,
    source: { ...writer.source, creationSource: "provider" as const },
  };

  expect(sidebarWorkerRecedes(reviewer, undefined)).toBe(true);
  expect(sidebarWorkerRecedes(issueWorker, "done")).toBe(true);
  expect(sidebarWorkerRecedes(issueWorker, "paused")).toBe(false);
  expect(sidebarWorkerRecedes(issueWorker, "suspended")).toBe(false);
  expect(sidebarWorkerRecedes(issueWorker, "idle")).toBe(false);
  expect(sidebarWorkerRecedes(writer, undefined)).toBe(false);
  expect(sidebarWorkerRecedes(pinned, undefined)).toBe(false);
  expect(sidebarWorkerRecedes(nativeWriter, undefined)).toBe(true);
});
