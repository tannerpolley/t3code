import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import { resolveSidebarThreadStatus, resolveThreadStatusPill } from "./Sidebar.logic";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { derivePhase } from "../session-logic";

const runtime = {
  status: "failed" as const,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: null,
  lastError: "failure",
  updatedAt: "2026-11-09T00:00:00Z",
};
const thread = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  interactionMode: "default" as const,
  runtime,
  latestRun: {
    runId: RunId.make("run"),
    status: "failed" as const,
    requestedAt: null,
    startedAt: null,
    completedAt: "2026-11-09T00:00:00Z",
    assistantMessageId: null,
  },
};

describe("thread activity disagreements", () => {
  it.each([
    [
      "failed with background work",
      {
        ...thread,
        pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" as const, awaited: true }],
      },
      "failed",
      "Failed",
    ],
    [
      "seen failure with background work",
      {
        ...thread,
        lastVisitedAt: "2026-11-09T01:00:00Z",
        pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" as const, awaited: true }],
      },
      "failed",
      "Failed",
    ],
    [
      "usage limit",
      { ...thread, runtime: { ...runtime, lastErrorClass: "usage_limit" as const } },
      "limited",
      "Limited",
    ],
    [
      "failed latest run with a terminal runtime",
      { ...thread, runtime: { ...runtime, status: "completed" as const } },
      "failed",
      "Failed",
    ],
  ] as const)("%s", (_name, input, status, label) => {
    expect(resolveSidebarThreadStatus(input)).toBe(status);
    expect(resolveThreadStatusPill({ thread: input })?.label).toBe(label);
  });
  it("keeps guest requests off the working shelf", () => {
    expect(
      isThreadWorking({
        ...thread,
        runtime: { ...runtime, status: "running" },
        pendingGuestMessageCount: 1,
      }),
    ).toBe(false);
  });
  it("treats queued work as waiting with an established connection", () => {
    expect(
      resolveSidebarThreadStatus({ ...thread, runtime: { ...runtime, status: "queued" } }),
    ).toBe("waiting");
    expect(derivePhase({ ...runtime, status: "queued" })).toBe("ready");
  });
});
