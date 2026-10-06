import { describe, expect, it } from "@effect/vitest";
import { RuntimeRequestId, RunId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { deriveIssueWorkStatus } from "./IssueWorkStatus.ts";

type StatusShell = NonNullable<Parameters<typeof deriveIssueWorkStatus>[0]["shell"]>;
const shell = (status: OrchestrationV2ThreadShell["status"]): StatusShell => ({
  status,
  deletedAt: null,
  archivedAt: null,
  pendingRuntimeRequest: null,
  activeRunId: null,
  pendingBackgroundTasks: [],
});
const derive = (
  value: StatusShell,
  options: { waitingOnSubIssues?: boolean; resultAvailable?: boolean; paused?: boolean } = {},
) => deriveIssueWorkStatus({ shell: value, paused: false, waitingOnSubIssues: false, ...options });

describe("deriveIssueWorkStatus", () => {
  it.each([
    ["queued", "queued_preparing"],
    ["preparing", "queued_preparing"],
    ["starting", "queued_preparing"],
    ["running", "working"],
    ["waiting", "working"],
    ["completed", "working"],
    ["failed", "failed"],
    ["interrupted", "interrupted"],
    ["cancelled", "cancelled"],
  ] as const)("maps %s to %s", (status, expected) => expect(derive(shell(status))).toBe(expected));

  it("requires a final delegated result and no owned work for done", () => {
    expect(derive(shell("completed"), { resultAvailable: true })).toBe("done");
    expect(derive(shell("completed"), { waitingOnSubIssues: true, resultAvailable: false })).toBe(
      "waiting_on_sub_issues",
    );
    expect(
      derive({ ...shell("running"), activeRunId: RunId.make("run") }, { waitingOnSubIssues: true }),
    ).toBe("working");
  });

  it("keeps queued root completion separate from issue completion and preserves availability", () => {
    expect(
      deriveIssueWorkStatus({
        shell: shell("completed"),
        paused: false,
        waitingOnSubIssues: false,
        queued: true,
      }),
    ).toBe("queued_preparing");
    expect(
      deriveIssueWorkStatus({
        shell: shell("failed"),
        paused: false,
        waitingOnSubIssues: false,
        queued: true,
      }),
    ).toBe("failed");
    expect(
      deriveIssueWorkStatus({
        shell: { ...shell("completed"), archivedAt: DateTime.makeUnsafe("2026-10-05T00:00:00Z") },
        paused: false,
        waitingOnSubIssues: false,
        queued: true,
      }),
    ).toBe("unavailable");
  });

  it("prioritizes user requests and repository pause", () => {
    expect(
      derive({
        ...shell("waiting"),
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request"),
          kind: "permission",
          createdAt: DateTime.makeUnsafe("2026-10-05T00:00:00Z"),
        },
      }),
    ).toBe("waiting_on_you");
    expect(derive(shell("running"), { paused: true })).toBe("paused");
  });

  it.each(["auth_refresh", "dynamic_tool_call"] as const)(
    "keeps %s requests working without asking the user",
    (kind) => {
      expect(
        derive({
          ...shell("waiting"),
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("internal-request"),
            kind,
            createdAt: DateTime.makeUnsafe("2026-10-05T00:00:00Z"),
          },
        }),
      ).toBe("working");
    },
  );
});
