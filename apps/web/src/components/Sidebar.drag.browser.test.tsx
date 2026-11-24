import { createMemoryHistory } from "@tanstack/react-router";
import { EMPTY_SIDEBAR_LAYOUT } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The thread route loads ChatView lazily; its first transform would eat the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { SIDEBAR_DISPLAY_KEY, useUiStateStore } from "~/uiStateStore";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";
import { makeThreadFixture } from "../test-fixtures";
import { SidebarSearchResultRow } from "./sidebar/SidebarThreadRow";

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

it("shows the titled preview inside and outside search results from a collapsed folder", async () => {
  await page.viewport(1400, 900);
  const [first, second] = [threadWithHistory("visible", 1), threadWithHistory("search-target", 1)];
  using _environment = installFakeEnvironment([first, second]);
  using cleanup = new DisposableStack();
  const localLayoutKey = `t3code:sidebar-local:${ENVIRONMENT_ID}`;
  const sidebarOpenKey = "chat_thread_sidebar_open";
  for (const key of [localLayoutKey, SIDEBAR_DISPLAY_KEY, sidebarOpenKey]) {
    const savedValue = localStorage.getItem(key);
    cleanup.defer(() => {
      if (savedValue === null) localStorage.removeItem(key);
      else localStorage.setItem(key, savedValue);
    });
  }
  localStorage.setItem(localLayoutKey, JSON.stringify(EMPTY_SIDEBAR_LAYOUT));
  localStorage.setItem(sidebarOpenKey, "true");
  const savedState = useUiStateStore.getState();
  cleanup.defer(() => useUiStateStore.setState(savedState, true));
  useUiStateStore.setState({ sidebarDisplaySnapshot: null, sidebarProjectScopeKeys: [] });
  const settings = getClientSettings();
  cleanup.defer(() => __setClientSettingsForTests(settings));
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    boringSidebarEnabled: true,
    projectsView: false,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const folder = page.getByRole("button", { name: /^render/ });
  await expect.element(folder).toHaveAttribute("aria-expanded", "true");
  // A removed row fades out as a clone without its test id, so match the live row only.
  const secondRow = page.getByTestId("sidebar-row-folder").filter({ hasText: second.title });
  await expect.element(secondRow).toBeInTheDocument();
  // The shift guard drops pointer presses on a row that appeared under 500ms ago; keys pass.
  folder.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(secondRow).not.toBeInTheDocument();
  await userEvent.fill(page.getByRole("combobox", { name: "Search threads" }), "search-target");
  const result = page.getByRole("option", { name: /Thread search-target/ });
  await expect.element(result).toBeVisible();
  const bounds = result.element().getBoundingClientRect();
  const pointer = (type: string, x: number, y: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: x,
      clientY: y,
    });
  using _release = {
    [Symbol.dispose]: () => document.dispatchEvent(pointer("pointerup", -100, 100)),
  };
  await act(() => {
    result.element().dispatchEvent(pointer("pointerdown", bounds.x + 10, bounds.y + 10));
    document.dispatchEvent(pointer("pointermove", bounds.x + 30, bounds.y + 10));
  });
  await vi.waitFor(() => {
    expect(
      document.querySelector('body > div[aria-hidden="true"].pointer-events-none')?.textContent,
    ).toBe(second.title);
  });
  await act(() => document.dispatchEvent(pointer("pointermove", -100, 100)));
  await vi.waitFor(() => {
    expect(
      document.querySelector('body > div[aria-hidden="true"].pointer-events-none')?.textContent,
    ).toBe(second.title);
  });
  await act(() => document.dispatchEvent(pointer("pointermove", bounds.x + 30, bounds.y + 10)));
  await vi.waitFor(() => {
    expect(
      document.querySelector('body > div[aria-hidden="true"].pointer-events-none')?.textContent,
    ).toBe(second.title);
  });
  await act(() =>
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", bubbles: true })),
  );
  await vi.waitFor(() => {
    expect(document.querySelector('body > div[aria-hidden="true"].pointer-events-none')).toBeNull();
  });
});

it("keeps focus in the search box when a click picks a search result", async () => {
  const onSelect = vi.fn();
  await using screen = await render(
    <>
      <input aria-label="Search threads" />
      <ul role="listbox">
        <SidebarSearchResultRow
          isSettled={false}
          thread={makeThreadFixture({ title: "Invoice export" })}
          project={null}
          projectKey={null}
          projectDisplayName={null}
          environmentLabel={null}
          environmentMachine="server"
          providerEntryByInstanceId={new Map()}
          isHighlighted={false}
          isRouteActive={false}
          resultId="result-0"
          searchMatch={null}
          searchQuery="invoice"
          onHighlight={() => {}}
          onSelect={onSelect}
          onContextMenu={() => {}}
          onFileDropThreads={() => {}}
        />
      </ul>
    </>,
  );
  const search = screen.getByRole("textbox", { name: "Search threads" });
  await userEvent.click(search);
  await userEvent.click(screen.getByRole("option"));
  expect(onSelect).toHaveBeenCalledOnce();
  // Picking clears the results; a focused result would drop focus, and its recovery scrolls the list.
  await expect.element(search).toHaveFocus();
});
