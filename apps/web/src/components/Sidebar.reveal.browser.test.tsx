import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
// The thread route loads ChatView lazily; its first transform would eat the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useUiStateStore } from "~/uiStateStore";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("scrolls the parent row back into view when Projects opens its subagent", async () => {
  const parent = threadWithHistory("parent", 1);
  const child = { ...threadWithHistory("subagent", 1), subagentOf: parent.id };
  const otherThreads = Array.from({ length: 40 }, (_, index) =>
    threadWithHistory(`other-${index}`, 1),
  );
  using _environment = installFakeEnvironment([parent, child, ...otherThreads]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const sidebar = useUiStateStore.getState();
  sidebar.setSidebarMode("projects");
  using _mode = { [Symbol.dispose]: () => sidebar.setSidebarMode(sidebar.sidebarMode) };
  await page.viewport(1400, 640);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${parent.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const parentRow = page.getByRole("button", { name: /^Orchestrator, Thread parent,/ });
  await expect.element(parentRow).toHaveAttribute("aria-current", "page");
  await expect.element(parentRow).toBeInViewport();
  const viewport = parentRow.element().closest('[data-slot="scroll-area-viewport"]')!;
  viewport.scrollTop = viewport.scrollHeight;
  await expect.element(parentRow).not.toBeInViewport();
  const parkedScrollTop = viewport.scrollTop;

  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: child.id },
    }),
  );

  await expect.element(page.getByText(`Answer 0 for ${child.id}.`)).toBeVisible();
  await vi.waitFor(() => expect(viewport.scrollTop).toBeLessThan(parkedScrollTop));
  await expect.element(parentRow).toBeInViewport();
});
