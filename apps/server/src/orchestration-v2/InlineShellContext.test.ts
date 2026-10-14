import { expect, it } from "vite-plus/test";
import { pendingInlineShellContext } from "./InlineShellContext.ts";
import {
  TurnItemId,
  ThreadId,
  RunAttemptId,
  ProviderThreadId,
  ProviderTurnId,
  NodeId,
  type OrchestrationV2TurnItem,
  type InlineShellRunRecord,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const threadId = ThreadId.make("thread");
const providerThreadId = ProviderThreadId.make("provider");
const attemptId = RunAttemptId.make("current");
const now = DateTime.makeUnsafe("2026-10-13T12:00:00Z");
const record: InlineShellRunRecord = {
  threadId,
  runId: "run",
  blockId: "message:0",
  language: "bash",
  command: "printf result; exit 7",
  terminalId: "inline-run",
  status: "completed",
  startedAt: "2026-10-13T11:59:00Z",
  completedAt: "2026-10-13T12:00:01Z",
  exitCode: 7,
  durationMs: 61000,
  output: "result",
};
const item: OrchestrationV2TurnItem = {
  id: TurnItemId.make("inline-shell:run"),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  type: "system_notice",
  message: "Inline shell run",
  inlineShellRun: record,
};
const turn: OrchestrationV2ProviderTurn = {
  id: ProviderTurnId.make("turn"),
  providerThreadId,
  nodeId: NodeId.make("node"),
  runAttemptId: RunAttemptId.make("previous"),
  nativeTurnRef: null,
  ordinal: 1,
  status: "completed",
  startedAt: now,
  completedAt: now,
};
it("shares command, exit, duration and output through terminal context on the next turn", () => {
  const context = pendingInlineShellContext([item], [turn], attemptId, providerThreadId);
  for (const value of ["printf result; exit 7", "Exit code: 7", "61000 ms", "result", "terminal"])
    expect(context).toContain(value);
  const after = { ...turn, startedAt: DateTime.makeUnsafe("2026-10-13T12:00:02Z") };
  expect(pendingInlineShellContext([item], [after], attemptId, providerThreadId)).toBe("");
  expect(pendingInlineShellContext([item], [after], attemptId, providerThreadId, true)).toContain(
    "result",
  );
  expect(
    pendingInlineShellContext(
      [{ ...item, inlineShellRun: { ...record, status: "running", completedAt: null } }],
      [],
      attemptId,
      providerThreadId,
    ),
  ).toBe("");
});
