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
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      quietThreadShellsAtom: Atom.make<readonly SidebarThreadSummary[]>([]),
    },
  };
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
