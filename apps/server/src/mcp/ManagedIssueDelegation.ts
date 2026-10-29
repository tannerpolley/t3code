import {
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestrationV2AppThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as IssueWorkService from "../issues/IssueWorkService.ts";
import * as IssueLinks from "../issues/IssueLinks.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import { isReadOnlyIssueRole, requiresManagedIssueAdmission } from "../issues/IssueEligibility.ts";

export const makeManagedIssueDelegation = Effect.gen(function* () {
  const issueWork = yield* Effect.serviceOption(IssueWorkService.IssueWorkService);
  const issueLinks = yield* Effect.serviceOption(IssueLinks.IssueLinks);
  const issueService = yield* Effect.serviceOption(IssueService.IssueService);
  const issueWorkStore = yield* Effect.serviceOption(IssueWorkStore.IssueWorkStore);
  const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
    new OrchestratorMcpFailure({ code, message });
  // The enclosing delegateTask operation owns the span and the validation order.
  const resolveIssue = Effect.fnUntraced(function* (
    input: OrchestratorMcpDelegateTaskInput,
    parent: { readonly thread: OrchestrationV2AppThread },
    loadRoot: (id: ThreadId) => Effect.Effect<OrchestrationV2AppThread, OrchestratorMcpFailure>,
  ) {
    const readOnly = isReadOnlyIssueRole(input.role);
    const root =
      readOnly || parent.thread.lineage.rootThreadId === parent.thread.id
        ? parent.thread
        : yield* loadRoot(parent.thread.lineage.rootThreadId);
    const managed = requiresManagedIssueAdmission(input.role, parent.thread, root);
    if (readOnly && input.issue !== undefined && Option.isNone(issueLinks))
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
    if (input.issue !== undefined && !readOnly) {
      if (Option.isNone(issueService) || Option.isNone(issueWorkStore))
        return yield* failure(
          "orchestration_error",
          "Issue-managed delegation is unavailable on this server.",
        );
      const detail = yield* issueService.value
        .detail(input.issue)
        .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
      if (detail.issue.state !== "open")
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
          "The repository orchestrator is unavailable or paused.",
        );
    }
    return { readOnly, linkedIssue };
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
  // Linking happens after the task projection is committed, as in the caller.
  const linkReadOnly = Effect.fnUntraced(function* (
    readOnly: boolean,
    issue: OrchestratorMcpDelegateTaskInput["issue"],
    childThreadId: ThreadId | null,
    parentThreadId: ThreadId,
  ) {
    if (readOnly && issue !== undefined && childThreadId !== null && Option.isSome(issueLinks))
      yield* issueLinks.value
        .link({ ...issue, threadId: childThreadId }, parentThreadId)
        .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
  });
  return { resolveIssue, startWorker, linkReadOnly };
});
