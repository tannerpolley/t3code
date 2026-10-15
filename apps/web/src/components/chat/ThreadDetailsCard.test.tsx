// @vitest-environment jsdom

import { EnvironmentId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const resize = vi.hoisted(() => ({ callbacks: new Set<() => void>() }));
vi.mock("../../lib/observeResize", () => ({
  observeResize: (_element: unknown, callback: () => void) => {
    resize.callbacks.add(callback);
    return () => resize.callbacks.delete(callback);
  },
}));
vi.mock("./ChatCanvasContext", () => ({
  useChatCanvas: () => ({
    container: { width: 1600, height: 600 },
    lane: { padding: 48 },
    layout: { frame: null },
    detailsCardTopInset: 0,
  }),
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./ThreadDetailsPrRow", () => ({
  ThreadDetailsPrRow: ({ number }: { number: number }) => <div data-test-row>#{number}</div>,
}));
vi.mock("~/state/entities", () => ({ useProjects: () => [] }));
vi.mock("~/state/threads", () => ({ threadEnvironment: {} }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/lib/openPullRequestLink", () => ({
  parseChangeRequestUrl: () => null,
  findProjectOnChangeRequestHost: () => undefined,
}));

import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { ThreadDetailsPrRows } from "./ThreadDetailsPrRows";

it("keeps workspace controls through expanding and collapsing PRs beside another long list", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no layout: supply row heights, leaving density decisions and list
  // expansion to the real components and their resize callback.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.querySelectorAll("[data-test-row]").length * 32;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.offsetHeight;
  });
  const links: ThreadPullRequestLink[] = Array.from({ length: 51 }, (_, index) => ({
    host: "github.com",
    repository: "pingdotgg/t3code",
    number: index + 1,
    url: `https://github.com/pingdotgg/t3code/pull/${index + 1}`,
    source: "manual",
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot: null,
    stack: null,
  }));
  const currentLink = links[0]!;
  const threadRef = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <ThreadDetailsCard
          threadRef={threadRef}
          anchor={{ current: null }}
          handle={PopoverPrimitive.createHandle()}
          onPresentationChange={() => {}}
        >
          {(density) => (
            <>
              {density === "full" ? <div data-test-row>Machine and project</div> : null}
              {density !== "essential" ? <div data-test-row>Open in…</div> : null}
              <div data-test-row>Add project script</div>
              <ThreadDetailsPrRows
                threadRef={threadRef}
                links={links}
                currentLink={currentLink}
                onOpenLink={() => {}}
                environmentId={threadRef.environmentId}
                pr={null}
                number={currentLink.number}
                reference={currentLink}
                status={null}
                project={null}
                label="#1"
                openAriaLabel="Open pull request"
                onOpen={() => {}}
              />
              {density === "full" ? (
                <div data-thread-details-lists>
                  {Array.from({ length: 20 }, (_, index) => (
                    <div key={index} data-test-row>
                      Issue {index}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </ThreadDetailsCard>,
      ),
    );
    const toggle = container.querySelector("button")!;
    for (const label of ["Show less", "Show 50 more", "Show less"]) {
      await act(() => toggle.click());
      await act(() => {
        for (const callback of resize.callbacks) callback();
      });
      expect(toggle.textContent).toBe(label);
      expect(container.textContent).toContain("Machine and project");
      expect(container.textContent).toContain("Open in…");
      expect(container.querySelectorAll("[data-test-row]")).toHaveLength(
        label === "Show less" ? 74 : 24,
      );
    }
  } finally {
    await act(() => root.unmount());
    container.remove();
    resize.callbacks.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
