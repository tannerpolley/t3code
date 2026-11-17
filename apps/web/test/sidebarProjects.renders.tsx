// Render scenarios for the Projects sidebar, on the whole app as in appScenarios.renders.tsx:
// hundreds of threads across five expanded projects, Claude orchestrators and Codex workers,
// one with running subagents. Each window counts renders, and the mount also counts the store
// subscriptions the mounted tree holds and the requests the app opened.
import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ProjectId, ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter, type AppRouter } from "~/router";
import { useUiStateStore } from "~/uiStateStore";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  PROJECT_ID,
  assistantItem,
  emitProviderStatuses,
  emitThreadEvent,
  installFakeEnvironment,
  rpcCallCounts,
  runningRun,
  threadWithHistory,
  userItem,
  type FakeDriver,
  type FakeThread,
} from "./fakeEnvironment";
import {
  commitsSoFar,
  countSnapshotReads,
  mountedSubscriptions,
  startCounting,
  stopCounting,
  type RenderReport,
} from "./renderCounter";
import { act, fakeTimers, render } from "./render";

vi.mock("../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("./fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const PROJECTS = ["render", "lab-1", "lab-2", "lab-3", "lab-4"];
const ORCHESTRATORS_PER_PROJECT = 6;
const WORKERS_PER_PROJECT = 54;
const SUBAGENTS = 3;
const STREAM_DELTAS = 10;
const CLAUDE = {
  instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER.instanceId),
  model: "claude-opus-4-6",
};

const projectIdOf = (index: number) =>
  index === 0 ? PROJECT_ID : ProjectId.make(`project-${PROJECTS[index]}`);

const THREADS: FakeThread[] = PROJECTS.flatMap((name, project) => [
  ...Array.from({ length: ORCHESTRATORS_PER_PROJECT }, (_, index) => ({
    ...threadWithHistory(`${name}-orchestrator-${index}`, 1, CLAUDE),
    projectId: projectIdOf(project),
    role: "orchestrator" as const,
  })),
  ...Array.from({ length: WORKERS_PER_PROJECT }, (_, index) => ({
    ...threadWithHistory(`${name}-worker-${index}`, 1),
    projectId: projectIdOf(project),
    role: "implementor" as const,
    worktreePath: `/workspace/${name}/.worktrees/worker-${index}`,
  })),
]);
const LEAD = THREADS[0]!.id;
for (let index = 0; index < SUBAGENTS; index++) {
  THREADS.push({
    ...threadWithHistory(`render-subagent-${index}`, 1),
    role: "implementor",
    subagentOf: LEAD,
  });
}
const LIVE = THREADS[ORCHESTRATORS_PER_PROJECT]!.id;
const OTHER = THREADS[ORCHESTRATORS_PER_PROJECT + 1]!.id;
const SELECTED = THREADS[ORCHESTRATORS_PER_PROJECT + 2]!.id;

installFakeEnvironment(THREADS, {
  providers: [CODEX_PROVIDER, CLAUDE_PROVIDER],
  extraProjects: PROJECTS.slice(1).map((title, index) => ({
    id: projectIdOf(index + 1),
    title,
  })),
});
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});
useUiStateStore.getState().setSidebarMode("projects");

async function quiet() {
  let seen = -1;
  await vi.waitFor(
    () => {
      const now = commitsSoFar();
      const settled = now === seen;
      seen = now;
      expect(settled).toBe(true);
    },
    { interval: 100, timeout: 15_000 },
  );
}

const frozenClock = () =>
  fakeTimers({ toFake: ["Date"], now: new Date("2026-03-18T09:00:30.000Z") });

const threadPath = (threadId: ThreadId) => `/${ENVIRONMENT_ID}/${threadId}`;
const rowOf = (threadId: ThreadId) =>
  document.querySelector<HTMLElement>(
    `[data-sidebar-row="${scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, threadId))}"]`,
  );

async function mountApp(threadId: ThreadId) {
  const router = getRouter(createMemoryHistory({ initialEntries: [threadPath(threadId)] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  await vi.waitFor(() => expect(rowOf(threadId)).not.toBeNull());
  await expect.element(page.getByText("Answer 0 for", { exact: false }).first()).toBeVisible();
  await quiet();
  return { screen, router };
}

async function measure(action: () => Promise<void>): Promise<RenderReport> {
  await quiet();
  startCounting();
  await action();
  await quiet();
  return stopCounting();
}

async function report(scenario: string, counted: RenderReport, extra: object = {}) {
  await commands.writeRenderReport(
    scenario,
    JSON.stringify({ ...counted, commits: null, ...extra }),
  );
}

const goToThread = (router: AppRouter, threadId: ThreadId) => async () => {
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId },
    }),
  );
  await vi.waitFor(() => expect(rowOf(threadId)?.getAttribute("aria-current")).toBe("page"));
};

it("warm up", async () => {
  using _clock = frozenClock();
  await using _app = (await mountApp(LIVE)).screen;
  await document.fonts.ready;
  await quiet();
});

it("projects-mount", async () => {
  using _clock = frozenClock();
  startCounting();
  await using _app = (await mountApp(LIVE)).screen;
  const counted = stopCounting();
  const held = mountedSubscriptions();
  await report("projects-mount", counted, {
    subscriptions: held.total,
    subscribers: held.components,
    rpc: Object.fromEntries(rpcCallCounts()),
  });
});

it("projects-stream-tick", async () => {
  using _clock = frozenClock();
  await using _app = (await mountApp(LIVE)).screen;
  const live = runningRun(LIVE, "live-run", 2, "live-user");
  await act(async () => {
    await emitThreadEvent(LIVE, { type: "run.created", payload: live });
    await emitThreadEvent(LIVE, {
      type: "turn-item.updated",
      payload: userItem(LIVE, live.id, "live-user", 2, "Continue"),
    });
  });
  await expect.element(page.getByText("Continue", { exact: true })).toBeVisible();
  await quiet();
  const stopReads = countSnapshotReads();
  const counted = await measure(async () => {
    let text = "";
    for (let delta = 0; delta < STREAM_DELTAS; delta++) {
      text += `word${delta}\n\n`;
      await act(() =>
        emitThreadEvent(LIVE, {
          type: "turn-item.updated",
          payload: assistantItem(LIVE, live.id, "live-assistant", 3, text, true),
        }),
      );
    }
    await expect
      .element(page.getByText(`word${STREAM_DELTAS - 1}`, { exact: false }))
      .toBeVisible();
  });
  const reads = stopReads();
  await report("projects-stream-tick", counted, {
    snapshotReads: reads.total,
    snapshotReaders: reads.components,
  });
});

it("projects-provider-status", async () => {
  using _clock = frozenClock();
  await using _app = (await mountApp(LIVE)).screen;
  const counted = await measure(() =>
    act(() =>
      emitProviderStatuses([
        { ...CODEX_PROVIDER, checkedAt: "2026-03-18T09:00:00.000Z" },
        { ...CLAUDE_PROVIDER, checkedAt: "2026-03-18T09:00:00.000Z" },
      ]),
    ),
  );
  await report("projects-provider-status", counted);
});

it("projects-switch-thread", async () => {
  using _clock = frozenClock();
  const { screen, router } = await mountApp(LIVE);
  await using _app = screen;
  const counted = await measure(goToThread(router, OTHER));
  await report("projects-switch-thread", counted);
});

it("projects-multi-select", async () => {
  using _clock = frozenClock();
  await using _app = (await mountApp(LIVE)).screen;
  const counted = await measure(async () => {
    await userEvent.click(rowOf(SELECTED)!, { modifiers: ["ControlOrMeta"] });
  });
  await report("projects-multi-select", counted);
});

it("projects-expand-project", async () => {
  using _clock = frozenClock();
  await using _app = (await mountApp(LIVE)).screen;
  const header = () =>
    [...document.querySelectorAll<HTMLElement>('[data-sidebar-row^="folder:"]')].find((row) =>
      row.textContent?.includes("lab-2"),
    );
  await userEvent.click(header()!);
  await vi.waitFor(() => expect(header()?.getAttribute("aria-expanded")).toBe("false"));
  const counted = await measure(async () => {
    await userEvent.click(header()!);
    await vi.waitFor(() => expect(header()?.getAttribute("aria-expanded")).toBe("true"));
  });
  await report("projects-expand-project", counted);
});

it("projects-worker-expansion", async () => {
  using _clock = frozenClock();
  await using _app = (await mountApp(LIVE)).screen;
  const leadKey = scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, LEAD));
  const toggle = () =>
    rowOf(LEAD)?.closest("li")?.querySelector<HTMLElement>('[aria-label*=" running "]');
  const children = () => document.querySelectorAll(`[data-sidebar-parent="${leadKey}"]`).length;
  await vi.waitFor(() => expect(toggle()?.getAttribute("aria-expanded")).toBe("true"));
  const shown = children();
  await userEvent.click(toggle()!);
  await vi.waitFor(() => expect(toggle()?.getAttribute("aria-expanded")).toBe("false"));
  const hidden = children();
  const counted = await measure(async () => {
    await userEvent.click(toggle()!);
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-expanded")).toBe("true"));
  });
  rowOf(LEAD)!.focus();
  await userEvent.keyboard("{ArrowDown}");
  await report("projects-worker-expansion", counted, {
    childRows: { shown, hidden, reshown: children() },
    arrowDownFromLeadLandsOnChild:
      document.activeElement?.getAttribute("data-sidebar-parent") === leadKey,
  });
});
