import { EnvironmentId, type UsageBudgetSummary } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { AsyncResult, Atom } from "effect/reactivity";
import { render } from "../../../test/render";
import type { EnvironmentUsageStatus } from "../../state/usage";

const { readBudget } = vi.hoisted(() => ({ readBudget: vi.fn() }));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, usageBudget: readBudget },
  };
});

import { UsageBudget } from "./UsageBudget";

it("ranks the selected remote environment and exposes coverage when a row is expanded", async () => {
  const remote = EnvironmentId.make("remote");
  const environment: EnvironmentUsageStatus = {
    environmentId: remote,
    label: "Remote",
    canReadDiagnostics: true,
    isConnected: true,
    isPending: false,
    error: null,
    summary: null,
  };
  const totals = {
    turns: 1,
    measuredTurns: 1,
    partialTurns: 1,
    input: 100,
    output: 25,
    uncachedInput: 0,
    cacheRead: 90,
    cacheWrite: 0,
    uncachedInputTurns: 0,
    cacheReadTurns: 1,
    cacheWriteTurns: 0,
    requests: 0,
    requestCountTurns: 0,
    firstContext: null,
    peakContext: 100,
    wakes: 1,
    deliveredResults: 3,
    residual: 0,
    residualTurns: 0,
  };
  const summary: UsageBudgetSummary = {
    since: "2026-11-16T18:00:00.000Z",
    asOf: "2026-11-23T18:00:00.000Z",
    providers: [
      {
        provider: "codex",
        totals,
        groups: {
          task: [{ key: "issue", label: "owner/repo #508", totals }],
          role: [],
          stage: [],
          wake: [{ key: "batch", label: "Batched child results", totals }],
        },
      },
    ],
  };
  readBudget.mockReset().mockReturnValue(Atom.make(AsyncResult.success(summary)));
  await using screen = await render(
    <UsageBudget
      environments={[
        environment,
        {
          ...environment,
          environmentId: EnvironmentId.make("limited"),
          label: "Limited",
          canReadDiagnostics: false,
          error: "Diagnostics access is required.",
        },
      ]}
      hiddenProviders={new Set()}
    />,
  );
  await expect.element(screen.getByText("owner/repo #508")).toBeVisible();
  expect(readBudget.mock.calls.map(([request]) => request.environmentId)).toContain(remote);
  expect(readBudget.mock.calls.some(([request]) => request.environmentId === "limited")).toBe(
    false,
  );
  await userEvent.click(screen.getByRole("button", { name: "Wake reason" }));
  await userEvent.click(screen.getByText("Batched child results"));
  await expect.element(screen.getByText("Delivered child results")).toBeVisible();
  await expect.element(screen.getByText("Requests", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("owner/repo #508")).not.toBeInTheDocument();
});
