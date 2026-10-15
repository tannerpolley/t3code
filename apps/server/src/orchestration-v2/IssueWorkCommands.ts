import type {
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ServerCommand,
  RunId,
  ThreadId,
  ThreadLinkedIssue,
} from "@t3tools/contracts";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import type { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  issueEligibility,
  sameIssueRepository,
  supportsManagedIssueWork,
  issueScopeExpansionError,
  managedIssueProviderError,
} from "../issues/IssueEligibility.ts";
import type { IssueWorkStore } from "../issues/IssueWorkStore.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import { IssueReadSnapshots } from "./IssueWorkDispatch.ts";
import type { makeIssueWorkRecovery } from "./IssueWorkRecovery.ts";
import type { OrchestratorDispatchError, OrchestratorV2Error } from "./Orchestrator.ts";
import type { ProjectionStoreV2, ProjectionRecords } from "./ProjectionStore.ts";
import type { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";

export type DelegatedTaskRequest = Omit<
  Extract<OrchestrationV2Command, { readonly type: "delegated_task.request" }>,
  "parentRunId" | "parentNodeId"
> & { readonly parentRunId: RunId | null; readonly parentNodeId: NodeId | null };

export interface ForkCommandHooks {
  readonly issueWorkStore: Option.Option<IssueWorkStore["Service"]>;
  readonly issueWorkRecovery: Effect.Success<typeof makeIssueWorkRecovery>;
  readonly projectionStore: ProjectionStoreV2["Service"];
  readonly idAllocator: IdAllocatorV2["Service"];
  readonly OrchestratorDispatchError: typeof OrchestratorDispatchError;
  readonly mapDispatchError: (
    command: OrchestrationV2ServerCommand,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, OrchestratorDispatchError, R>;
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorDispatchError>;
}

interface IssueWorkCommandHooks extends ForkCommandHooks {
  readonly providerAdapters: ProviderAdapterRegistryV2["Service"];
  readonly dispatchDelegatedTaskRequest: (
    request: DelegatedTaskRequest,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<void, OrchestratorV2Error>;
}

// Decisions use the supplied committed reads and collector; dispatch owns locks and commit.
export function makeIssueWorkCommands({
  issueWorkStore,
  issueWorkRecovery,
  projectionStore,
  idAllocator,
  emit,
  mapDispatchError,
  OrchestratorDispatchError,
  providerAdapters,
  dispatchDelegatedTaskRequest,
}: IssueWorkCommandHooks) {
  const issueSnapshot = (issue: ThreadLinkedIssue) =>
    Effect.map(IssueReadSnapshots, (reads) =>
      reads.find((read) => sameIssueRepository(read.issue, issue) && read.issue.id === issue.id),
    );
  const canStartIssueRun = (thread: OrchestrationV2AppThread) =>
    Effect.gen(function* () {
      const issue = thread.linkedIssue;
      if (issue === undefined) return true;
      if (Option.isNone(issueWorkStore)) return false;
      const store = issueWorkStore.value;
      if (
        !(yield* store.canAdmit(issue, thread.id)) ||
        (yield* store.issueOwner(issue)) !== thread.id
      )
        return false;
      const read = yield* issueSnapshot(issue);
      if (
        read === undefined ||
        issueEligibility(read) !== "eligible" ||
        (read.parent !== null && !sameIssueRepository(read.parent, issue))
      )
        return false;
      const parent =
        read.parent === null
          ? (yield* store.repositoryOwner(issue))?.rootThreadId
          : yield* store.issueOwner(read.parent);
      return parent === thread.lineage.parentThreadId;
    }).pipe(Effect.catch(() => Effect.succeed(false)));
  // An issue has one current worker, and only it is admitted to run. A message
  // from a person or agent to a former worker would queue for an admission that
  // never comes, so it is refused with the current worker's name instead.
  const guardFormerWorkerMessage = (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>,
    thread: OrchestrationV2AppThread,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) =>
    Effect.gen(function* () {
      const issue = thread.linkedIssue;
      if (
        issue === undefined ||
        Option.isNone(issueWorkStore) ||
        command.delegatedCompletion !== undefined ||
        (command.createdBy !== "user" && command.creationSource !== "mcp")
      )
        return;
      // A worker created earlier in this command owns its issue before the store records it.
      const createdOwner = (yield* Ref.get(events)).findLast(
        (event) =>
          event.type === "thread.created" &&
          event.payload.linkedIssue !== undefined &&
          sameIssueRepository(event.payload.linkedIssue, issue) &&
          event.payload.linkedIssue.id === issue.id,
      )?.threadId;
      const owner =
        createdOwner ??
        (yield* issueWorkStore.value.issueOwner(issue).pipe(mapDispatchError(command)));
      if (owner === null || owner === thread.id) return;
      const ownerShell = yield* projectionStore
        .getThreadShell(owner)
        .pipe(mapDispatchError(command));
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        detail: `Issue #${issue.number} is now worked by another thread${ownerShell ? ` ("${ownerShell.title}")` : ""}, ${owner}. Send this follow-up there, or delegate a new task for the issue.`,
      });
    });
  const start = Effect.fn("orchestrationV2.dispatch.issueWorkStart")(function* (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "issue.work.start" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    if (Option.isNone(issueWorkStore))
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Issue ownership service is unavailable.",
      });
    const store = issueWorkStore.value;
    const repository = yield* store.repositoryOwner(command.issue).pipe(mapDispatchError(command));
    if (repository?.rootThreadId !== command.threadId)
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `This repository root has retired. Route issue work to the current root ${repository?.rootThreadId ?? "(unavailable)"}.`,
      });
    if (repository.paused)
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "The repository root is unavailable or paused.",
      });
    const root = yield* projectionStore
      .getThreadShell(command.threadId)
      .pipe(mapDispatchError(command));
    if (root === null || root.archivedAt !== null || root.deletedAt !== null)
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "The registered repository root must be restored before starting work.",
      });
    const workerAdapter = yield* providerAdapters
      .get(command.workerModelSelection.instanceId)
      .pipe(mapDispatchError(command));
    if (!supportsManagedIssueWork(workerAdapter.driver))
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        detail: managedIssueProviderError,
      });
    const read = yield* issueSnapshot(command.issue);
    if (read === undefined || issueEligibility(read) !== "eligible")
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Issue work is closed, blocked, or its eligibility is unknown.",
      });
    if (read.parent !== null && !sameIssueRepository(read.parent, command.issue))
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        detail: issueScopeExpansionError,
      });
    const owner = yield* store.issueOwner(command.issue).pipe(mapDispatchError(command));
    let issueThreadId: ThreadId | null = null;
    if (owner !== null) {
      const current = yield* projectionStore
        .getThreadRecords(owner, ["runs", "messages", "subagents"])
        .pipe(mapDispatchError(command));
      const shell = yield* projectionStore.getThreadShell(owner).pipe(mapDispatchError(command));
      if (
        delegatedTaskProgress({
          ...current,
          pendingBackgroundTasks: shell?.pendingBackgroundTasks ?? [],
        }).state !== "result_available"
      )
        issueThreadId = owner;
    }
    const attemptKey = issueThreadId === null ? (owner ?? "first") : `active:${issueThreadId}`;
    const now = yield* DateTime.now;
    yield* emit(
      events,
      command,
    )({
      type: "issue.work.requested",
      threadId: command.threadId,
      occurredAt: now,
      payload: {
        requestId: command.commandId,
        issue: command.issue,
        parent: read.parent,
        rootThreadId: command.threadId,
        issueThreadId,
        attemptKey,
        modelSelection: command.workerModelSelection,
      },
    });
    if (issueThreadId !== null) return;
    const recipientId =
      read.parent === null
        ? command.threadId
        : yield* store.currentIssueOwner(read.parent).pipe(mapDispatchError(command));
    // Keep the leaf request durable until its ancestor owns a thread. The plan reactor
    // wakes that owner; attaching the leaf to the repository root would break lineage.
    if (recipientId === null) return;
    const recipient = yield* projectionStore
      .getThreadShell(recipientId)
      .pipe(mapDispatchError(command));
    if (recipient === null) return;
    yield* dispatchDelegatedTaskRequest(
      {
        type: "delegated_task.request",
        commandId: command.commandId,
        parentThreadId: recipientId,
        parentRunId: null,
        parentNodeId: null,
        issue: command.issue,
        task: `Implement issue #${command.issue.number}: ${command.issue.title}\n${command.issue.url}\nRead the issue and its comments, complete the authorized work, and report the result. Status and closeout comments are authorized. Other GitHub mutations and publishing retain separate approval.`,
        modelSelection: command.workerModelSelection,
        runtimeMode: recipient.runtimeMode,
        interactionMode: recipient.interactionMode,
        completionWake: "always",
        ...(command.issueWorktree === undefined
          ? {}
          : { workspaceStrategy: { type: "worktree" as const, ...command.issueWorktree } }),
        createdBy: command.createdBy,
        creationSource: command.creationSource,
      },
      events,
      effects,
      command,
    );
    const childThreadId = idAllocator.derive.delegatedTaskThread({ commandId: command.commandId });
    yield* Ref.update(events, (pending) =>
      pending.map((event) =>
        event.type === "issue.work.requested" && event.payload.requestId === command.commandId
          ? { ...event, payload: { ...event.payload, issueThreadId: childThreadId } }
          : event,
      ),
    );
  });

  const reuseManagedChild = (
    request: DelegatedTaskRequest,
    parentProjection: ProjectionRecords<
      "runs" | "nodes" | "subagents" | "providerThreads" | "providerTurns" | "attempts"
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) =>
    Effect.gen(function* () {
      const managed =
        parentProjection.thread.repositoryOrchestration !== undefined ||
        parentProjection.thread.linkedIssue !== undefined;
      if (managed && request.issue === undefined)
        return yield* new OrchestratorDispatchError({
          commandId: request.commandId,
          commandType: request.type,
          cause: "Repository-managed children require an explicit issue.",
        });
      if (request.issue !== undefined) {
        if (Option.isNone(issueWorkStore))
          return yield* new OrchestratorDispatchError({
            commandId: request.commandId,
            commandType: request.type,
            cause: "Issue ownership service is unavailable.",
          });
        const issueStore = issueWorkStore.value;
        const repositoryOwner = yield* issueStore
          .repositoryOwner(request.issue)
          .pipe(mapDispatchError(command));
        if (repositoryOwner === null || repositoryOwner.paused)
          return yield* new OrchestratorDispatchError({
            commandId: request.commandId,
            commandType: request.type,
            cause: "The repository is paused or issue relationships are unavailable.",
          });
        const read = yield* issueSnapshot(request.issue);
        if (read === undefined)
          return yield* new OrchestratorDispatchError({
            commandId: request.commandId,
            commandType: request.type,
            cause: "Issue relationships are unavailable; eligibility is unknown.",
          });
        if (read.parent !== null && !sameIssueRepository(read.parent, request.issue))
          return yield* new OrchestratorDispatchError({
            commandId: request.commandId,
            commandType: request.type,
            detail: issueScopeExpansionError,
          });
        if (parentProjection.thread.lineage.rootThreadId !== repositoryOwner.rootThreadId)
          return yield* new OrchestratorDispatchError({
            commandId: request.commandId,
            commandType: request.type,
            cause: `This repository issue subtree has retired. Delegate through the current root ${repositoryOwner.rootThreadId}.`,
          });
        const expectedParent =
          read.parent === null
            ? repositoryOwner.rootThreadId
            : yield* issueStore.issueOwner(read.parent).pipe(mapDispatchError(command));
        if (
          issueEligibility(read) !== "eligible" ||
          read.issue.id !== request.issue.id ||
          read.issue.repositoryId !== request.issue.repositoryId ||
          expectedParent !== request.parentThreadId ||
          parentProjection.thread.lineage.rootThreadId !== repositoryOwner.rootThreadId
        )
          return yield* new OrchestratorDispatchError({
            commandId: request.commandId,
            commandType: request.type,
            cause:
              "Issue work must be eligible and delegated by the current owner of its immediate GitHub parent (or the repository root for a top-level issue).",
          });
        const currentOwner = yield* issueStore
          .issueOwner(request.issue)
          .pipe(mapDispatchError(command));
        if (currentOwner !== null) {
          const current = yield* projectionStore
            .getThreadRecords(currentOwner, ["runs", "messages", "subagents"])
            .pipe(mapDispatchError(command));
          const shell = yield* projectionStore
            .getThreadShell(currentOwner)
            .pipe(mapDispatchError(command));
          if (
            delegatedTaskProgress({
              ...current,
              pendingBackgroundTasks: shell?.pendingBackgroundTasks ?? [],
            }).state !== "result_available"
          ) {
            const ownerThread = shell;
            const parent = ownerThread?.lineage.parentThreadId;
            const existing =
              parent === null || parent === undefined
                ? undefined
                : (yield* projectionStore
                    .getThreadRecords(parent, ["subagents"])
                    .pipe(mapDispatchError(command))).subagents.findLast(
                    (task) => task.childThreadId === currentOwner,
                  );
            if (existing === undefined || existing.threadId !== request.parentThreadId)
              return yield* new OrchestratorDispatchError({
                commandId: request.commandId,
                commandType: request.type,
                cause:
                  "This issue already has a current worker under another parent. Read its issue status and use that parent thread to manage it.",
              });
            yield* emit(
              events,
              command,
            )({
              type: "subagent.updated",
              threadId: existing.threadId,
              nodeId: existing.id,
              occurredAt: yield* DateTime.now,
              payload: existing,
            });
            return true;
          }
        }
      }

      return false;
    });

  const childIssueFields = (request: DelegatedTaskRequest) => ({
    ...(request.issue === undefined
      ? {}
      : { linkedIssue: request.issue, titleSource: "generated" as const }),
    ...(request.role === undefined ? {} : { role: request.role }),
  });

  // A child with its own worktree has no checkout until its deferred run's
  // preparation binds one; it never borrows the parent's.
  const childWorkspaceFields = (request: DelegatedTaskRequest) =>
    request.workspaceStrategy === undefined
      ? request.issue === undefined
        ? {}
        : { branch: null, worktreePath: null }
      : { branch: request.workspaceStrategy.branch ?? null, worktreePath: null };

  const cancel = (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "issue.work.cancel" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) =>
    Effect.gen(function* () {
      for (const event of yield* issueWorkRecovery.cancel(command).pipe(mapDispatchError(command)))
        yield* emit(events, command)<OrchestrationV2DomainEvent>(event);
    });

  return {
    canStartRun: canStartIssueRun,
    guardFormerWorkerMessage,
    start,
    reuseManagedChild,
    childIssueFields,
    childWorkspaceFields,
    cancel,
  };
}
