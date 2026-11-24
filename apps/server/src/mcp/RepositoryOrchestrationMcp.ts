import {
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadProjection,
  type RuntimeMode,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as IssueChangeService from "../issues/IssueChangeService.ts";
import type * as IssueWorkService from "../issues/IssueWorkService.ts";
import {
  requireThreadScope,
  threadLinkFor,
  type McpInvocationScope,
  type McpThreadInvocationScope,
} from "./McpInvocationContext.ts";
import { resolveRuntimeMode, resolveInteractionMode } from "./delegatedTaskModes.ts";
export interface RepositoryMcpMethods {
  readonly proposeIssueChange: (
    scope: McpInvocationScope,
    input: import("@t3tools/contracts").IssueChangeProposeInput,
  ) => Effect.Effect<import("@t3tools/contracts").IssueChange, OrchestratorMcpFailure>;
  readonly requestRepositoryHandoff: (
    scope: McpInvocationScope,
    input: import("@t3tools/contracts").RepositoryHandoffRequestInput,
  ) => Effect.Effect<import("@t3tools/contracts").RepositoryWorkResult, OrchestratorMcpFailure>;
  readonly workMilestone: (
    scope: McpInvocationScope,
    input: import("@t3tools/contracts").RepositoryWorkInput,
  ) => Effect.Effect<import("@t3tools/contracts").RepositoryWorkResult, OrchestratorMcpFailure>;
  readonly queueIssue: (
    scope: McpInvocationScope,
    input: import("@t3tools/contracts").IssueQueueInput,
  ) => Effect.Effect<import("@t3tools/contracts").RepositoryWorkResult, OrchestratorMcpFailure>;
  readonly unqueueIssue: (
    scope: McpInvocationScope,
    input: import("@t3tools/contracts").IssueQueueInput,
  ) => Effect.Effect<import("@t3tools/contracts").RepositoryWorkResult, OrchestratorMcpFailure>;
  readonly repositoryChildrenStatus: (
    scope: McpInvocationScope,
  ) => Effect.Effect<import("@t3tools/contracts").RepositoryChildrenStatus, OrchestratorMcpFailure>;
  readonly repositoryStatus: (
    scope: McpInvocationScope,
    input: import("@t3tools/contracts").IssueRepositoryRef,
  ) => Effect.Effect<import("@t3tools/contracts").RepositoryWorkResult, OrchestratorMcpFailure>;
  readonly setRepositoryWorkerLimit: (
    scope: McpInvocationScope,
    input: import("@t3tools/contracts").RepositoryConcurrencyLimitInput,
  ) => Effect.Effect<import("@t3tools/contracts").RepositoryWorkResult, OrchestratorMcpFailure>;
  readonly closeOutIssue: (
    scope: McpInvocationScope,
    input: import("@t3tools/contracts").IssueWorkCloseOutInput,
  ) => Effect.Effect<import("@t3tools/contracts").RepositoryWorkResult, OrchestratorMcpFailure>;
  readonly endRepositoryOrchestration: (
    scope: McpInvocationScope,
    input: import("@t3tools/contracts").RepositoryWorkEndInput,
  ) => Effect.Effect<import("@t3tools/contracts").RepositoryWorkResult, OrchestratorMcpFailure>;
  readonly setRepositoryPaused: (
    scope: McpInvocationScope,
    input: import("@t3tools/contracts").RepositoryWorkControlInput,
  ) => Effect.Effect<import("@t3tools/contracts").RepositoryWorkResult, OrchestratorMcpFailure>;
  readonly cancelIssueRequest: (
    scope: McpInvocationScope,
    input: import("@t3tools/contracts").IssueWorkCancelInput,
  ) => Effect.Effect<import("@t3tools/contracts").IssueWorkRequested, OrchestratorMcpFailure>;
  readonly restoreRepositoryRoot: (
    scope: McpInvocationScope,
    input: import("@t3tools/contracts").RepositoryWorkRestoreInput,
  ) => Effect.Effect<import("@t3tools/contracts").RepositoryWorkResult, OrchestratorMcpFailure>;
}

interface RepositoryMcpHooks {
  readonly issueWork: Option.Option<IssueWorkService.IssueWorkService["Service"]>;
  readonly issueChanges: Option.Option<IssueChangeService.IssueChangeService["Service"]>;
  readonly requireCapability: (
    scope: McpInvocationScope,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly loadCaller: (scope: McpInvocationScope) => Effect.Effect<
    {
      readonly limits: {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
      };
    },
    OrchestratorMcpFailure
  >;
  readonly loadThreadCaller: (
    scope: McpInvocationScope,
    operation: string,
  ) => Effect.Effect<
    {
      readonly parent: Pick<OrchestrationV2ThreadProjection, "thread">;
      readonly scope: McpThreadInvocationScope;
    },
    OrchestratorMcpFailure
  >;
}

export function makeRepositoryMcpMethods({
  issueWork,
  issueChanges,
  requireCapability,
  loadCaller,
  loadThreadCaller,
}: RepositoryMcpHooks) {
  const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
    new OrchestratorMcpFailure({ code, message });
  /** A retired repository root and its descendants keep history but cannot change orchestration. */
  const assertCurrentRepositoryCaller = (scope: McpInvocationScope) =>
    scope.thread === undefined || Option.isNone(issueWork)
      ? Effect.void
      : issueWork.value
          .assertCurrentCaller(scope.thread.threadId)
          .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));

  /** Repository-wide control needs a caller in full access and default mode. */
  const requireRepositoryController = Effect.fn(
    "OrchestratorMcpService.requireRepositoryController",
  )(function* (scope: McpInvocationScope) {
    const { limits } = yield* loadCaller(scope);
    yield* assertCurrentRepositoryCaller(scope);
    yield* resolveRuntimeMode(limits.runtimeMode, "full-access");
    yield* resolveInteractionMode(limits.interactionMode, "default");
  });

  const methods: RepositoryMcpMethods = {
    proposeIssueChange: Effect.fn("OrchestratorMcpService.proposeIssueChange")(
      function* (scope, input) {
        yield* requireCapability(scope);
        if (scope.thread === undefined || Option.isNone(issueChanges))
          return yield* failure("invalid_request", "Issue proposals require a managed thread.");
        // A retired root's subtree may finish its work but not plan new issue changes.
        yield* assertCurrentRepositoryCaller(scope);
        return yield* issueChanges.value
          .propose(scope.thread.threadId, input)
          .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
      },
    ),
    requestRepositoryHandoff: Effect.fn("OrchestratorMcpService.requestRepositoryHandoff")(
      function* (scope, input) {
        const { thread } = yield* requireThreadScope(scope, "request_repository_handoff");
        yield* requireRepositoryController(scope);
        if (Option.isNone(issueWork))
          return yield* failure("orchestration_error", "Issue work is unavailable.");
        return yield* issueWork.value
          .requestHandoff(thread.threadId, input)
          .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
      },
    ),
    workMilestone: Effect.fn("OrchestratorMcpService.workMilestone")(function* (scope, input) {
      yield* requireRepositoryController(scope);
      if (Option.isNone(issueWork))
        return yield* failure("orchestration_error", "Issue work is unavailable.");
      return yield* issueWork.value
        .workMilestone(input)
        .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
    }),
    queueIssue: Effect.fn("OrchestratorMcpService.queueIssue")(function* (scope, input) {
      yield* requireRepositoryController(scope);
      if (Option.isNone(issueWork))
        return yield* failure("orchestration_error", "Issue work is unavailable.");
      return yield* issueWork.value
        .queueIssue(input)
        .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
    }),
    unqueueIssue: Effect.fn("OrchestratorMcpService.unqueueIssue")(function* (scope, input) {
      yield* requireRepositoryController(scope);
      if (Option.isNone(issueWork))
        return yield* failure("orchestration_error", "Issue work is unavailable.");
      return yield* issueWork.value
        .unqueueIssue(input)
        .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
    }),
    repositoryChildrenStatus: Effect.fn("OrchestratorMcpService.repositoryChildrenStatus")(
      function* (scope) {
        yield* requireCapability(scope);
        if (scope.thread === undefined || Option.isNone(issueWork))
          return yield* failure(
            "invalid_request",
            "Child status requires a repository orchestrator.",
          );
        return yield* issueWork.value
          .childrenStatus(
            scope.thread.threadId,
            (threadId, title, environmentId = scope.environmentId) =>
              threadLinkFor({ ...scope, environmentId }, threadId, title),
          )
          .pipe(
            Effect.mapError((error) =>
              failure(
                error.code === "invalid-request" ? "invalid_request" : "orchestration_error",
                error.message,
              ),
            ),
          );
      },
    ),
    repositoryStatus: Effect.fn("OrchestratorMcpService.repositoryStatus")(
      function* (scope, input) {
        yield* loadCaller(scope);
        if (Option.isNone(issueWork))
          return yield* failure("orchestration_error", "Issue work is unavailable.");
        return yield* issueWork.value
          .repositoryStatus(input)
          .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
      },
    ),
    setRepositoryWorkerLimit: Effect.fn("OrchestratorMcpService.setRepositoryWorkerLimit")(
      function* (scope, input) {
        yield* requireRepositoryController(scope);
        if (Option.isNone(issueWork))
          return yield* failure("orchestration_error", "Issue work is unavailable.");
        if ((input.workerLimit === undefined) === (input.readOnlyLimit === undefined))
          return yield* failure(
            "invalid_request",
            "Provide exactly one of workerLimit or readOnlyLimit.",
          );
        return yield* (
          input.readOnlyLimit !== undefined
            ? issueWork.value.setReadOnlyLimit({ ...input, readOnlyLimit: input.readOnlyLimit })
            : issueWork.value.setWorkerLimit({ ...input, workerLimit: input.workerLimit! })
        ).pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
      },
    ),
    closeOutIssue: Effect.fn("OrchestratorMcpService.closeOutIssue")(function* (scope, input) {
      const caller = yield* loadThreadCaller(scope, "close_out_issue_attempt");
      yield* requireRepositoryController(scope);
      if (Option.isNone(issueWork))
        return yield* failure("orchestration_error", "Issue work is unavailable.");
      return yield* issueWork.value
        .closeOut(input, caller.parent.thread.id)
        .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
    }),
    endRepositoryOrchestration: Effect.fn("OrchestratorMcpService.endRepositoryOrchestration")(
      function* (scope, input) {
        yield* requireRepositoryController(scope);
        if (Option.isNone(issueWork))
          return yield* failure("orchestration_error", "Issue work is unavailable.");
        return yield* issueWork.value
          .endRepository(input)
          .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
      },
    ),
    setRepositoryPaused: Effect.fn("OrchestratorMcpService.setRepositoryPaused")(
      function* (scope, input) {
        yield* requireRepositoryController(scope);
        if (Option.isNone(issueWork))
          return yield* failure("orchestration_error", "Issue work is unavailable.");
        return yield* issueWork.value
          .setPaused(input)
          .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
      },
    ),
    cancelIssueRequest: Effect.fn("OrchestratorMcpService.cancelIssueRequest")(
      function* (scope, input) {
        yield* requireRepositoryController(scope);
        if (Option.isNone(issueWork))
          return yield* failure("orchestration_error", "Issue work is unavailable.");
        return yield* issueWork.value
          .cancelRequest(input)
          .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
      },
    ),
    restoreRepositoryRoot: Effect.fn("OrchestratorMcpService.restoreRepositoryRoot")(
      function* (scope, input) {
        yield* requireRepositoryController(scope);
        if (Option.isNone(issueWork))
          return yield* failure("orchestration_error", "Issue work is unavailable.");
        return yield* issueWork.value
          .restoreRoot(input)
          .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
      },
    ),
  };
  return { methods, assertCurrentRepositoryCaller };
}
