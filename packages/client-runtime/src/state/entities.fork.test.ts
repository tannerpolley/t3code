import { EnvironmentId, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell, resolveThreadWorkingStartedAt } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("environment-v2");

describe("V2 client presentation", () => {
  it("gives a run-less provider-native subagent child the runtime its shell status reports", () => {
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      status: "running",
      activityRunStatus: "running",
      activityRunStartedAt: v2ThreadShell.createdAt,
    });
    expect(shell.latestRun).toBeNull();
    expect(shell.runtime).toMatchObject({
      status: "running",
      activityStartedAt: "2026-06-20T00:00:00.000Z",
    });
  });

  it("times a working thread from its activity and a waiting one from its run, not an idle one", () => {
    const runId = RunId.make("run-waiting-clock");
    const runStartedAt = DateTime.makeUnsafe("2026-06-20T01:00:02.000Z");
    const settled = {
      ...v2ThreadShell,
      latestRunId: runId,
      latestRunStartedAt: runStartedAt,
      latestRunCompletedAt: DateTime.makeUnsafe("2026-06-20T01:03:00.000Z"),
      activeRunId: null,
      activityRunStatus: null,
      activityRunStartedAt: null,
      status: "completed" as const,
    };
    const working = presentThreadShell(environmentId, {
      ...settled,
      activeRunId: runId,
      activityRunStatus: "running",
      activityRunStartedAt: DateTime.makeUnsafe("2026-06-20T01:05:00.000Z"),
      status: "running",
    });
    const waiting = presentThreadShell(environmentId, {
      ...settled,
      pendingBackgroundTasks: [{ taskId: "monitor-1", taskType: "local_bash", kind: "monitor" }],
    });
    const idle = presentThreadShell(environmentId, settled);

    expect(resolveThreadWorkingStartedAt(working)).toBe("2026-06-20T01:05:00.000Z");
    // Its turn ended at 01:03, but the clock runs on from the run that started the monitor.
    expect(resolveThreadWorkingStartedAt({ ...waiting, waiting: true })).toBe(
      DateTime.formatIso(runStartedAt),
    );
    expect(resolveThreadWorkingStartedAt(waiting)).toBeNull();
    expect(resolveThreadWorkingStartedAt(idle)).toBeNull();
  });
});
