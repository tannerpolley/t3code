import {
  CheckpointScopeId,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

export class RunFinalizationError extends Schema.TaggedError<RunFinalizationError>()(
  "RunFinalizationError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    operation: Schema.Literals(["capture-checkpoint", "refresh-workspace"]),
    cause: Schema.Defect(),
  },
) {}

export class RunFinalizationRefreshError extends Schema.TaggedError<RunFinalizationRefreshError>()(
  "RunFinalizationRefreshError",
  { cwd: Schema.String, cause: Schema.Defect() },
) {}

export class RunFinalizationObserver extends Context.Reference<{
  readonly refreshAfterTurn: (projectId: ProjectId) => Effect.Effect<void>;
  readonly refresh: (input: {
    readonly cwd: string;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, RunFinalizationRefreshError>;
}>("t3/orchestration-v2/RunFinalizationObserver", {
  defaultValue: () => ({ refresh: () => Effect.void, refreshAfterTurn: () => Effect.void }),
}) {}

export class RunFinalizationService extends Context.Service<
  RunFinalizationService,
  {
    readonly finalize: (
      input: {
        readonly threadId: ThreadId;
        readonly runId: RunId;
        readonly scopeId: CheckpointScopeId;
      },
      options?: { readonly willRetry: boolean },
    ) => Effect.Effect<void, RunFinalizationError>;
  }
>()("t3/orchestration-v2/RunFinalizationService") {}

const make = Effect.gen(function* () {
  const checkpointCapture = yield* CheckpointCapture.CheckpointCaptureServiceV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const observer = yield* RunFinalizationObserver;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;

  const failCheckpointCapture = Effect.fn("RunFinalizationService.failCheckpointCapture")(
    function* (
      input: Parameters<RunFinalizationService["Service"]["finalize"]>[0],
      {
        run,
        rootNode,
      }: {
        readonly run: OrchestrationV2Run | undefined;
        readonly rootNode: OrchestrationV2ExecutionNode | undefined;
      },
    ) {
      if (run?.status !== "waiting" || run.activeAttemptId === null) return;
      const completedAt = yield* DateTime.now;
      const { delegatedCompletion: _delegatedCompletion, ...currentRun } = run;
      const nodeEvents: OrchestrationV2DomainEvent[] = [];
      if (rootNode?.status === "waiting") {
        nodeEvents.push({
          id: yield* ids.allocate.event({ threadId: input.threadId }),
          type: "node.updated",
          threadId: input.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: completedAt,
          payload: { ...rootNode, status: "failed", completedAt },
        });
      }
      // Provider success is not run success until its checkpoint commits; exhausted
      // capture must settle the waiting run so delegated requests can reach their owner.
      yield* eventSink.writeIfRunCurrent({
        threadId: input.threadId,
        runId: run.id,
        activeAttemptId: run.activeAttemptId,
        expectedStatus: "waiting",
        events: [
          {
            id: yield* ids.allocate.event({ threadId: input.threadId }),
            type: "turn-item.updated",
            threadId: input.threadId,
            runId: run.id,
            ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: completedAt,
            payload: {
              id: TurnItemId.make(`turn-item:checkpoint-failure:${run.id}`),
              threadId: input.threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerThreadId: run.providerThreadId,
              providerTurnId: rootNode?.providerTurnId ?? null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: run.ordinal * 100 + 99,
              status: "failed",
              title: "Checkpoint failed",
              startedAt: completedAt,
              completedAt,
              updatedAt: completedAt,
              type: "error",
              failure: makeProviderFailure({
                message:
                  "The turn finished, but its checkpoint could not be saved after all retries.",
                code: "checkpoint_capture_failed",
              }),
            },
          },
          {
            id: yield* ids.allocate.event({ threadId: input.threadId }),
            type: "run.updated",
            threadId: input.threadId,
            runId: run.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: completedAt,
            payload: { ...currentRun, status: "failed", completedAt },
          },
          ...nodeEvents,
        ],
      });
    },
  );

  const finalize: RunFinalizationService["Service"]["finalize"] = Effect.fn(
    "RunFinalizationService.finalize",
  )(function* (input, options) {
    const captureTarget =
      options?.willRetry === false
        ? yield* projections
            .getCheckpointCaptureContext(input.threadId, input)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new RunFinalizationError({ ...input, operation: "capture-checkpoint", cause }),
              ),
            )
        : undefined;
    yield* checkpointCapture.execute(input).pipe(
      Effect.tapCause((cause) =>
        captureTarget === undefined || Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : failCheckpointCapture(input, captureTarget),
      ),
      Effect.mapError(
        (cause) => new RunFinalizationError({ ...input, operation: "capture-checkpoint", cause }),
      ),
    );
    const projection = yield* projections
      .getCheckpointContext(input.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
        ),
      );
    const cwd = projection.checkpointScopes.find((scope) => scope.id === input.scopeId)?.cwd;
    if (cwd !== undefined) {
      yield* observer
        .refresh({ cwd, threadId: input.threadId, runId: input.runId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
          ),
        );
    }
  });
  return RunFinalizationService.of({ finalize });
});

export const layer = Layer.effect(RunFinalizationService, make);

export const layerObserver = Layer.effect(
  RunFinalizationObserver,
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const pullRequests = yield* PullRequestService.PullRequestService;
    return {
      refreshAfterTurn: pullRequests.refreshAfterTurn,
      refresh: ({ cwd, threadId, runId }) =>
        Effect.gen(function* () {
          const [, local] = yield* Effect.all(
            [workspaceEntries.refresh(cwd), vcsStatus.refreshLocalStatus(cwd)],
            { concurrency: "unbounded" },
          );
          if (local.refName === null || local.isDefaultRef) return;
          const thread = yield* projections.getThreadShell(threadId);
          if (!thread || thread.branch !== local.refName) return;
          if (thread.activeRunId !== null && thread.activeRunId !== runId) return;
          yield* vcsStatus.refreshPullRequestStatus(cwd).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to refresh pull request status after run completion", {
                threadId,
                cwd,
                detail: error.message,
              }),
            ),
          );
        }).pipe(Effect.mapError((cause) => new RunFinalizationRefreshError({ cwd, cause }))),
    };
  }),
);
