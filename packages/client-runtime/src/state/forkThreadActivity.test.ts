import { expect, it } from "vite-plus/test";
import { resolveThreadActivity, type ThreadActivityInput } from "./forkThreadActivity.ts";

it.each<{ name: string; input: ThreadActivityInput; expected: string }>([
  {
    name: "approval wins over input and failure",
    input: { hasPendingApprovals: true, hasPendingUserInput: true, runtime: { status: "failed" } },
    expected: "approval",
  },
  { name: "child approval", input: { pendingSubagentRequest: "approval" }, expected: "approval" },
  {
    name: "input wins over guest",
    input: { hasPendingUserInput: true, pendingGuestMessageCount: 1 },
    expected: "input",
  },
  { name: "child input", input: { pendingSubagentRequest: "user_input" }, expected: "input" },
  {
    name: "guest request interrupts working",
    input: { pendingGuestMessageCount: 1, runtime: { status: "running" } },
    expected: "request",
  },
  { name: "queued", input: { runtime: { status: "queued" } }, expected: "waiting" },
  {
    name: "blocked thread wait",
    input: { runtime: { status: "running" }, blockedOnThreadWait: true },
    expected: "waiting",
  },
  ...(["preparing", "starting"] as const).map((status) => ({
    name: status,
    input: { runtime: { status } },
    expected: "connecting",
  })),
  ...(["running", "waiting"] as const).map((status) => ({
    name: status,
    input: { runtime: { status }, latestRun: { status: "failed" as const } },
    expected: "working",
  })),
  {
    name: "usage limit",
    input: { runtime: { status: "failed", lastErrorClass: "usage_limit" } },
    expected: "limited",
  },
  {
    name: "failure beats background wait",
    input: {
      runtime: { status: "idle" },
      latestRun: { status: "failed" },
      pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", awaited: true }],
    },
    expected: "failed",
  },
  {
    name: "failed latest run with terminal runtime",
    input: { runtime: { status: "completed" }, latestRun: { status: "failed" } },
    expected: "failed",
  },
  { name: "parked at idle", input: { runtime: { status: "idle" } }, expected: "waiting" },
  {
    name: "awaited work without a run",
    input: { pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", awaited: true }] },
    expected: "waiting",
  },
  {
    name: "unawaited work stays ready",
    input: { pendingBackgroundTasks: [{ taskId: "server", kind: "command" }] },
    expected: "ready",
  },
  { name: "completed", input: { runtime: { status: "completed" } }, expected: "ready" },
  { name: "no runtime", input: {}, expected: "ready" },
])("$name", ({ input, expected }) => expect(resolveThreadActivity(input)).toBe(expected));
