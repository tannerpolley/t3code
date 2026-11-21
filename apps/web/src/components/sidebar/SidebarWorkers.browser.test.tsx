import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { ThreadId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { Profiler, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadShells } from "../../state/threads";
import { makeThreadFixture } from "../../test-fixtures";
import type { SidebarThreadSummary } from "../../types";
import { SidebarBackgroundWorkRows } from "./SidebarBackgroundWorkRows";
import { SidebarWorkerRows } from "./SidebarWorkers";

vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const page = {
    snapshotSequence: 1,
    threads: [],
    nextWorkerPage: {
      threadId: ThreadId.make("worker-at-cursor"),
      createdAt: "2026-11-20T00:00:00.000Z",
    },
    remainingWorkers: 1,
  };
  const pagingFixture = Atom.family((key: string) => {
    const [, parentId, count] = JSON.parse(key) as [string, string, number];
    const growing = parentId === "Growing parent";
    const rows = Atom.make(
      count === 0
        ? []
        : growing
          ? [{ snapshotSequence: 1, threads: [], remainingWorkers: 0 }]
          : [page],
    );
    return {
      rows,
      state: Atom.map(rows, (pages) => ({
        pages,
        waiting: false,
        failedQuery:
          !growing && count === 2 ? Atom.make(AsyncResult.initial<never, never>()) : null,
      })),
    };
  });
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      quietThreadShellsAtom: Atom.make<readonly SidebarThreadSummary[]>([]),
    },
    threadFamilies: {
      ...actual.threadFamilies,
      workerPages: (key: string) => {
        const [, parentId] = JSON.parse(key) as [string, string, number];
        return parentId === "Paged parent" || parentId === "Growing parent"
          ? pagingFixture(key)
          : actual.threadFamilies.workerPages(key);
      },
    },
  };
});

vi.mock(import("../../state/shell"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const snapshot = Atom.make({
    schemaVersion: 1,
    snapshotSequence: 1,
    projects: [],
    threads: [],
    archivedThreads: [],
    omittedWorkers: ["Paged parent", "Growing parent"].map((id) => ({
      parentThreadId: ThreadId.make(id),
      count: 1,
    })),
  });
  return { ...actual, environmentSnapshotAtom: () => snapshot };
});

function worker(title: string, parent?: SidebarThreadSummary): SidebarThreadSummary {
  const id = ThreadId.make(title);
  return makeThreadFixture({
    id,
    title,
    ...(parent === undefined
      ? {}
      : {
          lineage: {
            rootThreadId: parent.lineage.rootThreadId,
            parentThreadId: parent.id,
            relationshipToParent: "subagent",
          },
        }),
  });
}

function setupRows(threads: readonly SidebarThreadSummary[]) {
  const atom = environmentThreadShells.quietThreadShellsAtom as Atom.Writable<
    readonly SidebarThreadSummary[]
  >;
  appAtomRegistry.set(atom, threads);
  return { [Symbol.dispose]: () => appAtomRegistry.set(atom, []) };
}

function workerRouter(ui: ReactNode, threadId: ThreadId) {
  const root = createRootRoute({
    component: () => (
      <>
        {ui}
        <Outlet />
      </>
    ),
  });
  const route = createRoute({
    getParentRoute: () => root,
    path: "/$environmentId/$threadId",
  });
  return createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/environment-test/${threadId}`] }),
    disableGlobalCatchBoundary: true,
  });
}

it("targets the idle checker for clicks and context menus beneath a running implementor", async () => {
  const root = worker("Orchestrator");
  const parent = worker("Implementor", root);
  const child = worker("Checker", parent);
  using _rows = setupRows([root, parent, child]);
  const onClick = vi.fn();
  const onContextMenu = vi.fn();
  await using screen = await render(
    <AppAtomRegistryProvider>
      <SidebarBackgroundWorkRows
        columns
        environmentId={root.environmentId}
        threadId={root.id}
        rows={[
          {
            kind: "subagent",
            taskId: parent.id,
            childThreadId: parent.id,
            child: parent,
            label: parent.title,
            startedAt: null,
          },
        ]}
        onChildClick={onClick}
        onChildContextMenu={onContextMenu}
      />
      <SidebarWorkerRows thread={root} onClick={onClick} onContextMenu={onContextMenu} />
    </AppAtomRegistryProvider>,
  );
  const checker = screen.getByRole("button", { name: /Checker/ });
  await checker.click();
  await checker.click({ button: "right" });
  expect(onClick.mock.calls[0]?.[1]?.id).toBe(child.id);
  expect(onContextMenu.mock.calls[0]?.[0]?.id).toBe(child.id);
});

it("updates the two selected rows without rendering an unrelated worker list", async () => {
  const parent = worker("Parent");
  const other = worker("Other");
  const first = worker("First", parent);
  const second = worker("Second", parent);
  const leaf = worker("Unrelated", other);
  using _rows = setupRows([parent, other, first, second, leaf]);
  const onRender = vi.fn();
  const onClick = vi.fn();
  const onContextMenu = vi.fn();
  const router = workerRouter(
    <>
      <SidebarWorkerRows thread={parent} onClick={onClick} onContextMenu={onContextMenu} />
      <Profiler id="unrelated" onRender={onRender}>
        <SidebarWorkerRows thread={other} onClick={onClick} onContextMenu={onContextMenu} />
      </Profiler>
    </>,
    first.id,
  );
  // This fixture supplies the parameterized thread routes the selector subscribes to.
  await using screen = await render(
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  await expect
    .element(screen.getByRole("button", { name: /First/ }))
    .toHaveAttribute("aria-current", "true");
  onRender.mockClear();
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: parent.environmentId, threadId: second.id },
    }),
  );
  await expect
    .element(screen.getByRole("button", { name: /Second/ }))
    .toHaveAttribute("aria-current", "true");
  expect(onRender).not.toHaveBeenCalled();
});

it("offers a retry after the next worker page fails", async () => {
  const parent = worker("Paged parent");
  await using screen = await render(
    <AppAtomRegistryProvider>
      <SidebarWorkerRows thread={parent} onClick={vi.fn()} onContextMenu={vi.fn()} />
    </AppAtomRegistryProvider>,
  );
  await screen.getByRole("button", { name: "Show more workers (1)" }).click();
  await expect.element(screen.getByRole("button", { name: "Retry loading workers" })).toBeVisible();
});

it("reveals an eleventh worker after the server page is exhausted", async () => {
  const parent = worker("Growing parent");
  const children = Array.from({ length: 10 }, (_, index) => worker(`Worker ${index}`, parent));
  using _rows = setupRows([parent, ...children]);
  await using screen = await render(
    <AppAtomRegistryProvider>
      <SidebarWorkerRows thread={parent} onClick={vi.fn()} onContextMenu={vi.fn()} />
    </AppAtomRegistryProvider>,
  );
  await expect.element(screen.getByRole("button", { name: /Worker 0$/ })).toBeVisible();
  using _updated = setupRows([parent, ...children, worker("Worker added", parent)]);
  await expect.element(screen.getByRole("button", { name: /Worker 0$/ })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Show more workers (1)" }).click();
  await expect.element(screen.getByRole("button", { name: /Worker 0$/ })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /Worker added$/ })).toBeVisible();
});
