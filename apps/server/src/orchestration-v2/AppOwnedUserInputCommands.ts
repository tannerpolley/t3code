import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ExecutionNode,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ServerCommand,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { CommandId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";
import { canWakeDelegatedRequest } from "./DelegatedRequestWake.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import type { ForkCommandHooks } from "./IssueWorkCommands.ts";
import type {
  OrchestratorProjectionError,
  OrchestratorV2DispatchResult,
  OrchestratorV2Error,
} from "./Orchestrator.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionRecords,
} from "./ProjectionStore.ts";

interface AppOwnedUserInputHooks extends Pick<
  ForkCommandHooks,
  "projectionStore" | "idAllocator" | "emit" | "mapDispatchError" | "OrchestratorDispatchError"
> {
  readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
  readonly loadProjectionForCommand: <K extends ProjectionRecordField>(
    command: OrchestrationV2Command,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, OrchestratorProjectionError>;
  readonly nextTurnItemOrdinal: (
    projection: Pick<OrchestrationV2ThreadProjection, "thread"> &
      Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>,
  ) => Effect.Effect<number, OrchestratorProjectionError>;
  readonly dispatchRuntimeRequestRespond: (
    command: Extract<OrchestrationV2Command, { type: "runtime-request.respond" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) => Effect.Effect<void, OrchestratorV2Error>;
  readonly dispatchWithReceiptEffect: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<OrchestratorV2DispatchResult, OrchestratorV2Error>;
}

// The orchestrator owns locks, snapshots, event collection, and commit.
export function makeAppOwnedUserInputCommands({
  projectionStore,
  idAllocator,
  emit,
  mapDispatchError,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  loadProjectionForCommand,
  nextTurnItemOrdinal,
  dispatchRuntimeRequestRespond,
  dispatchWithReceiptEffect,
}: AppOwnedUserInputHooks) {
  const dispatchRuntimeRequestCreateUserInput = Effect.fn(
    "Orchestrator.dispatchRuntimeRequestCreateUserInput",
  )(function* (
    command: Extract<
      OrchestrationV2Command,
      { readonly type: "runtime-request.create-user-input" }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    if (command.questions.length < 1 || command.questions.length > 3)
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "A user-input request must contain one to three questions.",
      });
    const questionIds = command.questions.map((question) => question.id);
    if (
      new Set(questionIds).size !== questionIds.length ||
      command.questions.some(
        (question) =>
          question.options.length > 20 ||
          (question.options.length === 0 && question.allowCustomAnswer === false),
      )
    )
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "The user-input questions repeat an id or have invalid options.",
      });
    const totalQuestionCharacters = command.questions.reduce(
      (total, question) =>
        total +
        question.id.length +
        question.header.length +
        question.question.length +
        question.options.reduce(
          (optionTotal, option) =>
            optionTotal +
            option.label.length +
            option.description.length +
            (option.value?.length ?? 0),
          0,
        ),
      0,
    );
    if (totalQuestionCharacters > 20_000)
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "The user-input questions exceed the supported size limit.",
      });

    const active = yield* projectionStore
      .getRunningTurnContext(command.threadId)
      .pipe(mapDispatchError(command));
    const projection = yield* loadProjectionForCommand(
      command,
      ["runs", "nodes", "providerThreads", "providerTurns", "runtimeRequests", "turnItems"],
      { turnItemRunId: command.runId },
    );
    const run = active.run;
    const providerThread = active.providerThread;
    const providerTurn = active.providerTurn;
    const rootNode = projection.nodes.find((node) => node.id === run?.rootNodeId);
    if (
      projection.runtimeRequests.some((request) => request.id === command.requestId) ||
      run === undefined ||
      run.id !== command.runId ||
      run.status !== "running" ||
      run.activeAttemptId === null ||
      run.rootNodeId === null ||
      providerThread === undefined ||
      providerThread.id !== projection.thread.activeProviderThreadId ||
      providerThread.providerSessionId !== command.providerSessionId ||
      providerThread.providerInstanceId !== run.providerInstanceId ||
      providerThread.appThreadId !== command.threadId ||
      providerThread.ownerNodeId !== null ||
      providerThread.status !== "active" ||
      run.providerThreadId !== providerThread.id ||
      providerTurn === undefined ||
      providerTurn.providerThreadId !== providerThread.id ||
      providerTurn.runAttemptId !== run.activeAttemptId ||
      providerTurn.status !== "running" ||
      rootNode === undefined ||
      rootNode.runId !== run.id ||
      rootNode.kind !== "root_turn"
    )
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "A user-input request can only be created by the active provider turn.",
      });

    const now = yield* DateTime.now;
    const nodeId = idAllocator.derive.approvalNode({ requestId: command.requestId });
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId: command.threadId,
      runId: run.id,
      parentNodeId: rootNode.id,
      rootNodeId: rootNode.id,
      kind: "user_input_request",
      status: "waiting",
      countsForRun: false,
      providerThreadId: providerThread.id,
      providerTurnId: providerTurn.id,
      nativeItemRef: null,
      runtimeRequestId: command.requestId,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    const request = {
      id: command.requestId,
      nodeId,
      providerTurnId: providerTurn.id,
      nativeRequestRef: null,
      kind: "user_input" as const,
      status: "pending" as const,
      responseCapability: {
        type: "app_owned" as const,
        providerSessionId: command.providerSessionId,
      },
      createdAt: now,
      resolvedAt: null,
    };
    const item: OrchestrationV2TurnItem = {
      id: idAllocator.derive.approvalTurnItem({ requestId: command.requestId }),
      threadId: command.threadId,
      runId: run.id,
      nodeId,
      providerThreadId: providerThread.id,
      providerTurnId: providerTurn.id,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: yield* nextTurnItemOrdinal(projection),
      status: "waiting",
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "user_input_request",
      requestId: command.requestId,
      questions: [...command.questions],
    };
    const emitEvent = emit(events, command);
    yield* emitEvent({
      type: "node.updated",
      threadId: command.threadId,
      runId: run.id,
      nodeId,
      driver: providerThread.driver,
      providerInstanceId: providerThread.providerInstanceId,
      occurredAt: now,
      payload: node,
    });
    yield* emitEvent({
      type: "runtime-request.updated",
      threadId: command.threadId,
      runId: run.id,
      nodeId,
      driver: providerThread.driver,
      providerInstanceId: providerThread.providerInstanceId,
      occurredAt: now,
      payload: request,
    });
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId: run.id,
      nodeId,
      driver: providerThread.driver,
      providerInstanceId: providerThread.providerInstanceId,
      occurredAt: now,
      payload: item,
    });
  });

  const cancelEndedRunQuestions = Effect.fn("Orchestrator.cancelEndedRunQuestions")(function* (
    threadId: ThreadId,
    runId: RunId,
  ) {
    const projection = yield* projectionStore
      .getThreadRecords(threadId, ["runtimeRequests", "nodes"])
      .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
    const runNodeIds = new Set(
      projection.nodes.filter((node) => node.runId === runId).map((node) => node.id),
    );
    for (const request of projection.runtimeRequests) {
      if (
        request.status !== "pending" ||
        request.kind !== "user_input" ||
        request.responseCapability.type !== "app_owned" ||
        !runNodeIds.has(request.nodeId)
      ) {
        continue;
      }
      yield* dispatchWithReceiptEffect({
        type: "runtime-request.respond",
        commandId: CommandId.make(`command:system:run-ended-user-input:${request.id}`),
        threadId,
        requestId: request.id,
        decision: "cancel",
      });
    }
  });

  // Run interruption already owns the dispatch span.
  const cancelInterruptedRunQuestions = Effect.fnUntraced(function* (
    command: Extract<OrchestrationV2ServerCommand, { type: "run.interrupt" }>,
    projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "nodes">,
    run: OrchestrationV2Run,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    // Stop answers the run's own t3_request_user_input question with a cancel now;
    // the provider may take a while to end the turn.
    for (const request of projection.runtimeRequests) {
      if (
        request.status !== "pending" ||
        request.kind !== "user_input" ||
        request.responseCapability.type !== "app_owned" ||
        projection.nodes.find((node) => node.id === request.nodeId)?.runId !== run.id
      ) {
        continue;
      }
      yield* dispatchRuntimeRequestRespond(
        {
          type: "runtime-request.respond",
          commandId: command.commandId,
          threadId: command.threadId,
          requestId: request.id,
          decision: "cancel",
        },
        events,
        effects,
      );
    }
  });

  // Routed wake dispatch already owns the span and parent lock.
  const canWake = Effect.fnUntraced(function* (
    task: OrchestrationV2Subagent,
    request: OrchestrationV2RuntimeRequest,
  ) {
    const allowed = yield* canWakeDelegatedRequest(projectionStore, task, request).pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: task.threadId, cause }),
      ),
    );
    return allowed;
  });

  return {
    dispatchRuntimeRequestCreateUserInput,
    cancelEndedRunQuestions,
    cancelInterruptedRunQuestions,
    canWake,
  };
}
