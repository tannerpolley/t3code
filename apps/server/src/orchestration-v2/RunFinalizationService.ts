import * as Option from "effect/Option";
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
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
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
  const eventSink = yield* Effect.serviceOption(EventSink.EventSinkV2);
  const ids = yield* Effect.serviceOption(IdAllocator.IdAllocatorV2);

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
      if (
        run?.status !== "waiting" ||
        run.activeAttemptId === null ||
        Option.isNone(eventSink) ||
        Option.isNone(ids)
      )
        return;
      const completedAt = yield* DateTime.now;
      const { delegatedCompletion: _delegatedCompletion, ...currentRun } = run;
      const nodeEvents: OrchestrationV2DomainEvent[] = [];
      if (rootNode?.status === "waiting") {
        nodeEvents.push({
          id: yield* ids.value.allocate.event({ threadId: input.threadId }),
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
      yield* eventSink.value.writeIfRunCurrent({
        threadId: input.threadId,
        runId: run.id,
        activeAttemptId: run.activeAttemptId,
        expectedStatus: "waiting",
        events: [
          {
            id: yield* ids.value.allocate.event({ threadId: input.threadId }),
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
            id: yield* ids.value.allocate.event({ threadId: input.threadId }),
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
      // Retrying a display refresh after the checkpoint is durable blocks the next turn.
      yield* observer.refresh({ cwd, threadId: input.threadId, runId: input.runId }).pipe(
        Effect.catchTags({
          RunFinalizationRefreshError: (cause) =>
            Effect.logWarning("Failed to refresh workspace after checkpoint capture", {
              ...input,
              cause,
            }),
        }),
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
    const projects = yield* ProjectService.ProjectService;
    const enrichment = yield* ProjectEnrichment.ProjectEnrichmentService;
    const pullRequestLookups = yield* FiberMap.make<string>();
    const identityRefreshes = yield* FiberMap.make<ProjectId>();
    // A turn can add the first remote (`git remote add`, `gh repo create --push`), which the
    // enrichment and resolver caches would otherwise keep reporting as missing for a minute.
    const refreshMissingRepositoryIdentity = Effect.fn(
      "RunFinalizationService.refreshMissingRepositoryIdentity",
    )(
      function* (projectId: ProjectId) {
        const project = yield* projects.getById(projectId);
        if (Option.isNone(project)) return;
        const { workspaceRoot } = project.value;
        if ((yield* enrichment.readRepositoryIdentity(workspaceRoot)) !== null) return;
        yield* enrichment.refreshRepositoryIdentity(workspaceRoot);
      },
      (effect, projectId) =>
        effect.pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to refresh repository identity after run completion", {
              projectId,
              detail: error.message,
            }),
          ),
        ),
    );
    return {
      refreshAfterTurn: pullRequests.refreshAfterTurn,
      refresh: Effect.fn("RunFinalizationService.refresh")(
        function* ({ cwd, threadId, runId }) {
          const [, local] = yield* Effect.all(
            [workspaceEntries.refresh(cwd), vcsStatus.refreshLocalStatus(cwd)],
            { concurrency: "unbounded" },
          );
          const thread = yield* projections.getThreadShell(threadId);
          if (!thread) return;
          // Forge discovery probes can take seconds; like the PR lookup, the next turn must not wait.
          yield* refreshMissingRepositoryIdentity(thread.projectId).pipe(
            FiberMap.run(identityRefreshes, thread.projectId),
          );
          if (local.refName === null || local.isDefaultRef) return;
          if (thread.branch !== local.refName) return;
          if (thread.activeRunId !== null && thread.activeRunId !== runId) return;
          // The forge CLI can take minutes, so the next turn must not wait for it. A newer
          // turn's lookup replaces a running one instead of queueing behind the cwd's lock.
          yield* vcsStatus.refreshPullRequestStatus(cwd).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to refresh pull request status after run completion", {
                threadId,
                cwd,
                detail: error.message,
              }),
            ),
            FiberMap.run(pullRequestLookups, cwd),
          );
        },
        (effect, { cwd }) =>
          effect.pipe(Effect.mapError((cause) => new RunFinalizationRefreshError({ cwd, cause }))),
      ),
    };
  }),
);
