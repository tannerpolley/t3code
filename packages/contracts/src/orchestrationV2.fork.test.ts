import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./index.ts";
import { StoredProjectIcon } from "./project.ts";
import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2UserInputQuestion,
  OrchestrationV2DelegatedCompletionCohort,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2NotificationSource,
  OrchestrationV2Command,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2TurnItemJson,
} from "./orchestrationV2.ts";

const decodeLegacyUserInputQuestion = Schema.decodeUnknownSync(OrchestrationV2UserInputQuestion);

it("ignores the removed secret flag in persisted user-input questions", () => {
  const question = decodeLegacyUserInputQuestion({
    id: "legacy",
    header: "Choice",
    question: "Choose",
    options: [],
    isSecret: true,
  });
  expect(question).not.toHaveProperty("isSecret");
  expect(question.question).toBe("Choose");
});

const decodePendingBackgroundTask = Schema.decodeSync(OrchestrationV2PendingBackgroundTask);

const now = DateTime.makeUnsafe("2026-04-20T00:00:00.000Z");
const decodeOrchestrationV2Command = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeOrchestrationV2TurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const decodeOrchestrationV2ProviderThreadJson = Schema.decodeUnknownSync(
  OrchestrationV2ProviderThreadJson,
);
const encodeOrchestrationV2ProviderThreadJson = Schema.encodeSync(
  OrchestrationV2ProviderThreadJson,
);

describe("orchestration V2 contracts", () => {
  it("preserves persisted fork metadata when decoding and re-encoding", () => {
    const timestamp = "2026-04-20T00:00:00.000Z";
    const thread = {
      createdBy: "user",
      creationSource: "web",
      id: "thread-1",
      projectId: "project-1",
      title: "Thread",
      titleSource: "generated",
      titleEvaluation: { requestId: "title-1", outcome: "unchanged", evaluatedAt: timestamp },
      providerInstanceId: "claudeAgent",
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
      forkedFrom: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const task = {
      taskId: "task-1",
      taskType: "local_bash",
      description: "Run checks",
      childThreadId: "child-1",
      startedAt: timestamp,
      commandKind: "python",
      ownerThreadId: "child-1",
    };
    const providerThread = {
      id: "provider-thread-1",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: null,
      appThreadId: "thread-1",
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      contextUsage: null,
      nativeMetadata: null,
      pendingBackgroundTasks: [
        task,
        { ...task, taskId: "task-2", kind: "command", command: "python check.py" },
      ],
    };
    const assistantItem = {
      id: "item-1",
      threadId: "thread-1",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: timestamp,
      type: "assistant_message",
      messageId: "message-1",
      text: "Done",
      streaming: false,
      phase: "final_answer",
    };
    const payloadSchema = Schema.Struct({
      thread: OrchestrationV2AppThreadJson,
      completion: OrchestrationV2DelegatedCompletionCohort,
      assistantItems: Schema.Array(OrchestrationV2TurnItemJson),
      projectIcon: StoredProjectIcon,
      sources: Schema.Array(OrchestrationV2NotificationSource),
      providerThread: OrchestrationV2ProviderThreadJson,
    });
    const nativeRef = { driver: "claude", nativeId: "native-1", strength: "strong" };
    const payload = {
      thread,
      completion: {
        disposition: "open",
        nextGeneration: 2,
        delivery: null,
        settledDeliveryCount: 1,
      },
      assistantItems: [assistantItem, { ...assistantItem, id: "item-2", phase: "commentary" }],
      projectIcon: { kind: "lucide", name: "folder", color: "blue", folder: true },
      sources: [
        { kind: "background_task", nativeRef },
        { kind: "background_command", nativeRef },
        { kind: "monitor", nativeRef },
        { kind: "background_task", work: "subagent", childThreadId: "child-1", nativeRef },
      ],
      providerThread,
    };
    const decoded = Schema.decodeUnknownSync(payloadSchema)(payload);
    const encoded = Schema.encodeSync(payloadSchema)(decoded);
    expect(encoded).toEqual({
      ...payload,
      projectIcon: { kind: "folder", color: "blue" },
      providerThread: {
        ...providerThread,
        goal: null,
        pendingBackgroundTasks: [
          { ...task, kind: "background_task" },
          { ...task, taskId: "task-2", kind: "command", command: "python check.py" },
        ],
      },
    });
    // Runtime decoding preserves the same metadata after JSON dates become DateTime values.
    expect(
      decodePendingBackgroundTask({
        ...task,
        startedAt: now,
      }),
    ).toEqual({ ...task, startedAt: now, kind: "background_task" });
    expect(
      decodePendingBackgroundTask({
        ...task,
        startedAt: now,
        kind: "command",
        command: "python check.py",
      }),
    ).toEqual({ ...task, startedAt: now, kind: "command", command: "python check.py" });
  });
});

describe("background work kinds from older or newer servers", () => {
  const storedNotification = (source: unknown) => ({
    id: "notification",
    threadId: "parent",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-09-09T00:00:00.000Z",
    type: "notification",
    outcome: "completed",
    summary: "Background activity updated",
    source,
  });

  it("decodes notification sources stored before specific kinds existed", () => {
    const sourceOf = (source: unknown) => {
      const item = decodeOrchestrationV2TurnItemJson(storedNotification(source));
      return item.type === "notification" ? item.source : undefined;
    };
    expect(
      sourceOf({
        kind: "background_task",
        nativeRef: { driver: "claude", nativeId: "task-1", strength: "strong" },
      }),
    ).toEqual({
      kind: "background_task",
      nativeRef: { driver: "claude", nativeId: "task-1", strength: "strong" },
    });
    expect(sourceOf({ kind: "background_command" })).toEqual({ kind: "command" });
    expect(sourceOf({ kind: "monitor" })).toEqual({ kind: "monitor" });
  });

  it("decodes rosters stored before kinds existed, and kinds from a newer server, as generic tasks", () => {
    const providerThread = decodeOrchestrationV2ProviderThreadJson({
      id: "provider-thread-1",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: null,
      appThreadId: "thread-1",
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      pendingBackgroundTasks: [
        { taskId: "bg-1", description: "Background sleep", taskType: "local_bash" },
        { taskId: "bg-2" },
        { taskId: "bg-3", description: "Nightly", kind: "workflow", schedule: "0 3 * * *" },
        { taskId: "bg-4", description: "npm test", kind: "command" },
        { taskId: "bg-5", kind: "subagent", childThreadId: "thread-child" },
        { taskId: "bg-6", kind: "subagent", providerInstanceId: "claudeAgent" },
      ],
    });
    expect(providerThread.pendingBackgroundTasks).toEqual([
      {
        taskId: "bg-1",
        description: "Background sleep",
        taskType: "local_bash",
        kind: "background_task",
      },
      { taskId: "bg-2", kind: "background_task" },
      { taskId: "bg-3", description: "Nightly", kind: "background_task" },
      { taskId: "bg-4", description: "npm test", kind: "command" },
      { taskId: "bg-5", kind: "subagent", childThreadId: "thread-child" },
      { taskId: "bg-6", kind: "subagent", providerInstanceId: "claudeAgent" },
    ]);
    const encoded = encodeOrchestrationV2ProviderThreadJson(providerThread).pendingBackgroundTasks;
    expect(encoded).toEqual(providerThread.pendingBackgroundTasks);
    const decodePreKindsRoster = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          taskId: TrimmedNonEmptyString,
          description: Schema.optional(TrimmedNonEmptyString),
          taskType: Schema.optional(TrimmedNonEmptyString),
        }),
      ),
    );
    expect(decodePreKindsRoster(encoded).map((task) => task.taskId)).toEqual([
      "bg-1",
      "bg-2",
      "bg-3",
      "bg-4",
      "bg-5",
      "bg-6",
    ]);
    expect(() =>
      decodeOrchestrationV2ProviderThreadJson({
        ...encodeOrchestrationV2ProviderThreadJson(providerThread),
        pendingBackgroundTasks: [{ taskId: "", kind: "command" }],
      }),
    ).toThrow();
  });
});

it("does not decode worker-only recovery annotations from client commands", () => {
  const marker = {
    runId: "run",
    from: { instanceId: "codex", model: "sol" },
    to: null,
    resetAt: null,
    message: "Forged switch",
  };
  for (const input of [
    {
      type: "thread.metadata.update",
      commandId: "client-marker",
      threadId: "thread",
      autoProviderSwitch: marker,
    },
    {
      type: "provider.switch",
      commandId: "client-switch",
      threadId: "thread",
      modelSelection: { instanceId: "codex", model: "sol" },
      autoProviderSwitch: marker,
    },
    {
      type: "message.dispatch",
      commandId: "client-continue",
      threadId: "thread",
      messageId: "message",
      text: "Continue",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
      automaticProviderContinuationOfRunId: "run",
    },
  ]) {
    const decoded = decodeOrchestrationV2Command(input);
    expect(decoded).not.toHaveProperty("autoProviderSwitch");
    expect(decoded).not.toHaveProperty("automaticProviderContinuationOfRunId");
  }
});
