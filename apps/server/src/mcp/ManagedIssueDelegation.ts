import {
  IssueTrackerKind,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2AppThread,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as IssueWorkService from "../issues/IssueWorkService.ts";
import * as TrackerIssueService from "../issue/IssueService.ts";
import * as ThreadIssueService from "../orchestration-v2/ThreadIssueService.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import {
  isReadOnlyIssueRole,
  isUnmanagedIssueRole,
  requiresManagedIssueAdmission,
} from "../issues/IssueEligibility.ts";

export const delegatedIssueRef = (
  projectId: ProjectId,
  issue: NonNullable<OrchestratorMcpDelegateTaskInput["issue"]>,
) => ({
  projectId,
  tracker: IssueTrackerKind.make("github"),
  host: (issue.host ?? "github.com").toLowerCase(),
  scope: issue.repository,
  key: String(issue.number),
});

export const makeManagedIssueDelegation = Effect.fn("ManagedIssueDelegation.make")(function* (
  loadThread: (id: ThreadId) => Effect.Effect<OrchestrationV2AppThread, OrchestratorMcpFailure>,
) {
  const issueWork = yield* Effect.serviceOption(IssueWorkService.IssueWorkService);
  const trackerIssues = yield* Effect.serviceOption(TrackerIssueService.IssueService);
  const threadIssues = yield* Effect.serviceOption(ThreadIssueService.ThreadIssueService);
  const issueService = yield* Effect.serviceOption(IssueService.IssueService);
  const issueWorkStore = yield* Effect.serviceOption(IssueWorkStore.IssueWorkStore);
  const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
    new OrchestratorMcpFailure({ code, message });
  // The enclosing delegateTask operation owns the span and the validation order.
  const resolveIssue = Effect.fnUntraced(function* (
    input: OrchestratorMcpDelegateTaskInput,
    parent: { readonly thread: OrchestrationV2AppThread },
  ) {
    const unmanaged = isUnmanagedIssueRole(input.role);
    const root =
      unmanaged || parent.thread.lineage.rootThreadId === parent.thread.id
        ? parent.thread
        : yield* loadThread(parent.thread.lineage.rootThreadId);
    const managed = requiresManagedIssueAdmission(input.role, parent.thread, root);
    if (
      unmanaged &&
      input.issue !== undefined &&
      (Option.isNone(trackerIssues) || Option.isNone(threadIssues))
    )
      return yield* failure("orchestration_error", "Issue linking is unavailable on this server.");
    if (managed && input.issue === undefined)
      return yield* failure(
        "invalid_request",
        "Repository-managed children require an explicit issue argument.",
      );
    if (managed && input.mode === "wait")
      return yield* failure(
        "invalid_request",
        "Managed issue delegation uses async mode so the root can finish its turn while workers run.",
      );
    let linkedIssue: import("@t3tools/contracts").ThreadLinkedIssue | undefined;
    if (input.issue !== undefined && !unmanaged) {
      if (Option.isNone(issueService) || Option.isNone(issueWorkStore))
        return yield* failure(
          "orchestration_error",
          "Issue-managed delegation is unavailable on this server.",
        );
      const read = yield* issueService.value
        .workRead({ ...input.issue, host: input.issue.host ?? "github.com" })
        .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
      if (read.state !== "open")
        return yield* failure("invalid_request", "Only open issues can be delegated.");
      linkedIssue = yield* issueService.value
        .resolveLinkedIssue({ ...input.issue, host: input.issue.host ?? "github.com" })
        .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
      const repositoryOwner = yield* issueWorkStore.value
        .repositoryOwner(linkedIssue)
        .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
      if (repositoryOwner === null || repositoryOwner.paused)
        return yield* failure(
          "invalid_request",
          repositoryOwner === null
            ? yield* IssueWorkStore.missingOwnerMessage(
                issueWorkStore.value,
                linkedIssue,
                "The repository orchestrator is unavailable or paused.",
              ).pipe(Effect.mapError((error) => failure("orchestration_error", error.message)))
            : "The repository orchestrator is unavailable or paused.",
        );
    }
    return { unmanaged, linkedIssue };
  });
  // The delegateTask span owns admission and its transport error mapping.
  const startWorker = Effect.fnUntraced(function* (
    command: Parameters<IssueWorkService.IssueWorkService["Service"]["startWorker"]>[0],
    providerFailure: (error: unknown) => OrchestratorMcpFailure,
  ) {
    if (Option.isNone(issueWork))
      return yield* failure(
        "orchestration_error",
        "Issue-managed delegation is unavailable on this server.",
      );
    return yield* issueWork.value
      .startWorker(command)
      .pipe(
        Effect.mapError((error) =>
          error._tag === "ThreadManagementProviderInstanceDisabledError"
            ? providerFailure(error)
            : failure("orchestration_error", error.message),
        ),
      );
  });
  // The child already exists and runs, so a failure here must not fail the delegation: a retry
  // would start a second child. A failed read names the link by its number.
  const linkUnmanaged = Effect.fnUntraced(function* (
    unmanaged: boolean,
    issue: OrchestratorMcpDelegateTaskInput["issue"],
    childThreadId: ThreadId | null,
    parent: OrchestrationV2AppThread,
  ) {
    if (
      !unmanaged ||
      issue === undefined ||
      childThreadId === null ||
      Option.isNone(trackerIssues) ||
      Option.isNone(threadIssues)
    )
      return;
    const ref = delegatedIssueRef(parent.projectId, issue);
    const detail = yield* trackerIssues.value.detail(ref).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("delegated child linked without reading its issue", {
          thread: childThreadId,
          reason: error.message,
        }),
      ),
      Effect.orElseSucceed(() => ({
        url: `https://${ref.host}/${ref.scope}/issues/${ref.key}`,
        displayKey: `#${issue.number}`,
        title: `#${issue.number}`,
      })),
    );
    yield* threadIssues.value
      .link({
        threadId: childThreadId,
        ref,
        url: detail.url,
        displayKey: detail.displayKey,
        title: detail.title,
        source: "agent",
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("delegated child could not be linked to its issue", {
            thread: childThreadId,
            reason: error.message,
          }),
        ),
      );
  });
  // The delegateTask span owns the response; pool policy belongs with admission.
  const withQueueNote = Effect.fnUntraced(function* (
    taskResult: OrchestratorMcpDelegateTaskResult,
    parent: OrchestrationV2AppThread,
    taskCommand: Extract<OrchestrationV2ServerCommand, { type: "delegated_task.request" }>,
  ) {
    if (taskResult.status !== "queued" || Option.isNone(issueWork)) return taskResult;
    const root =
      parent.repositoryOrchestration === undefined
        ? yield* loadThread(parent.lineage.rootThreadId)
        : parent;
    const config = root?.repositoryOrchestration;
    if (config === undefined) return taskResult;
    const status = yield* issueWork.value
      .repositoryStatus(config)
      .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
    const readers = isReadOnlyIssueRole(taskCommand.role);
    if (!readers && taskCommand.issue === undefined) return taskResult;
    const current = status.orchestration;
    if (current === null) return taskResult;
    const limit = readers ? current.readOnlyLimit : current.workerLimit;
    const used = readers ? status.readOnlySlotsInUse : status.slotsInUse;
    return used < limit
      ? taskResult
      : {
          ...taskResult,
          queueNote: `Queued on the ${readers ? "readers" : "workers"} pool: ${used} of ${limit} slots in use.`,
        };
  });
  return { resolveIssue, startWorker, linkUnmanaged, withQueueNote };
});
