import { keepIssueWorktree } from "../issues/issueThreadRetention.ts";
import { isDraftPrRepository, issueWorkerBrief } from "../issues/IssueWorkerBrief.ts";
import {
  IssueTrackerKind,
  MessageId,
  repositoryAdmitsWork,
  repositoryPhase,
} from "@t3tools/contracts";
import { codexRoleSpeedFromSelection } from "@t3tools/shared/model";
import type {
  DelegatedToolAdditions,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ServerCommand,
  OrchestrationV2StoredEvent,
  OrchestrationV2Subagent,
  RunId,
  ThreadId,
  ThreadIssueLink,
  ThreadLinkedIssue,
} from "@t3tools/contracts";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import type { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  issueEligibility,
  issueAdmissionEligible,
  isReadOnlyIssueRole,
  isUnmanagedIssueRole,
  requiresManagedIssueAdmission,
  sameIssueRepository,
  supportsManagedIssueWork,
  issueScopeExpansionError,
  managedIssueProviderError,
} from "../issues/IssueEligibility.ts";
import type { IssueWorkStore } from "../issues/IssueWorkStore.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import { exceededDispatchModeLimit } from "./DispatchModeLimit.ts";
import {
  IssueQueueSnapshot,
  IssueReadSnapshots,
  retainedWorkerSuccessor,
} from "./IssueWorkDispatch.ts";
import type { makeIssueWorkRecovery } from "./IssueWorkRecovery.ts";
import type { OrchestratorDispatchError, OrchestratorV2Error } from "./Orchestrator.ts";
import type { ProjectionStoreV2, ProjectionRecords } from "./ProjectionStore.ts";
import type { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";

function toolAdditionKeys(additions: DelegatedToolAdditions) {
  return new Set(
    additions.map((entry) => (typeof entry === "string" ? entry : `mcp:${entry.mcpServer}`)),
  );
}

export function isSettledIssueWorkerTask(task: OrchestrationV2Subagent) {
  return (
    task.origin === "app_owned" &&
    task.result !== null &&
    task.completionDelivery?.state !== "pending" &&
    task.completionDelivery?.state !== "claimed"
  );
}

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
  readonly draftPrRepositories: ReadonlySet<string>;
  readonly recordSubagentFollowup: (
    command: Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) => Effect.Effect<void, OrchestratorV2Error>;
  readonly dispatchMessage: (
    command: Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) => Effect.Effect<void, OrchestratorV2Error>;
  readonly providerAdapters: ProviderAdapterRegistryV2["Service"];
  readonly dispatchDelegatedTaskRequest: (
    request: DelegatedTaskRequest,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<void, OrchestratorV2Error>;
}

/**
 * The claim and its `thread.issues[]` link, written by the one event that creates the claimed
 * thread, so screens and tools see the claim like any other link.
 */
export const claimFields = (
  issue: ThreadLinkedIssue | undefined,
  projectId: ProjectId,
  now: DateTime.Utc,
): { linkedIssue?: ThreadLinkedIssue; issues?: ThreadIssueLink[] } =>
  issue === undefined
    ? {}
    : {
        linkedIssue: issue,
        issues: [
          {
            tracker: IssueTrackerKind.make("github"),
            host: issue.host.toLowerCase(),
            scope: issue.repository,
            key: String(issue.number),
            projectId,
            url: issue.url,
            source: "agent",
            linkedAt: DateTime.formatIso(now),
            displayKey: `#${issue.number}`,
            title: issue.title.trim() || "Untitled issue",
          },
        ],
      };

const issueKey = (issue: ThreadLinkedIssue) => `${issue.host}:${issue.repositoryId}:${issue.id}`;

// Decisions use the supplied committed reads and collector; dispatch owns locks and commit.
export function makeIssueWorkCommands({
  issueWorkStore,
  issueWorkRecovery,
  projectionStore,
  idAllocator,
  emit,
  mapDispatchError,
  OrchestratorDispatchError,
  draftPrRepositories,
  providerAdapters,
  dispatchDelegatedTaskRequest,
  dispatchMessage,
  recordSubagentFollowup,
}: IssueWorkCommandHooks) {
  const issueSnapshot = (issue: ThreadLinkedIssue) =>
    Effect.map(IssueReadSnapshots, (reads) =>
      reads.find((read) => sameIssueRepository(read.issue, issue) && read.issue.id === issue.id),
    );
  const adoptionLineage = Effect.fn("IssueWorkCommands.adoptionLineage")(function* (
    thread: OrchestrationV2AppThread,
    successorRoot?: ThreadId,
  ) {
    const issue = thread.linkedIssue;
    if (issue === undefined || Option.isNone(issueWorkStore)) return null;
    const store = issueWorkStore.value;
    const successor = successorRoot ?? (yield* retainedWorkerSuccessor(store, thread));
    if (successor === null || (yield* store.issueOwner(issue)) !== thread.id) return null;
    const parent = thread.lineage.parentThreadId;
    // A handoff transfers management even when the issue host cannot admit a run yet.
    if (parent === thread.lineage.rootThreadId)
      return { ...thread.lineage, rootThreadId: successor, parentThreadId: successor };
    if (parent === null) return null;
    const currentParent = yield* projectionStore.findThread(parent);
    const parentIssue = currentParent?.linkedIssue;
    if (
      currentParent?.lineage.rootThreadId !== successor ||
      parentIssue === undefined ||
      !sameIssueRepository(parentIssue, issue) ||
      (yield* store.issueOwner(parentIssue)) !== parent
    )
      return null;
    return { ...thread.lineage, rootThreadId: successor };
  });
  /** Why this thread's next run must wait for admission, or null when it may start now. */
  const issueRunAdmissionWait = Effect.fn("issueRunAdmissionWait")(
    function* (thread: OrchestrationV2AppThread) {
      if (
        thread.linkedIssue === undefined &&
        isReadOnlyIssueRole(thread.role) &&
        thread.lineage.relationshipToParent === "subagent"
      ) {
        if (Option.isNone(issueWorkStore)) return null;
        const store = issueWorkStore.value;
        const root = thread.lineage.rootThreadId;
        if (!(yield* store.isRepositoryOrchestrator(root))) return null;
        if (yield* store.canAdmitReadOnly(root, thread.id)) return null;
        const config = yield* store.configuration(root);
        return config?.automaticHandoff?.status === "verifying"
          ? "repository_paused"
          : "read_only_limit";
      }
      const issue = thread.linkedIssue;
      if (issue === undefined) return null;
      if (Option.isNone(issueWorkStore)) return "repository_paused";
      const store = issueWorkStore.value;
      if ((yield* store.issueOwner(issue)) !== thread.id) return "not_current_worker";
      const wait = yield* store.admissionWait(issue, thread.id);
      if (wait !== null) return wait;
      const read = yield* issueSnapshot(issue);
      if (
        read === undefined ||
        issueEligibility(read) !== "eligible" ||
        (read.parent !== null && !sameIssueRepository(read.parent, issue))
      )
        return "issue_suspended";
      const parent =
        read.parent === null
          ? (yield* store.repositoryOwner(issue))?.rootThreadId
          : yield* store.issueOwner(read.parent);
      return parent === thread.lineage.parentThreadId ? null : "not_current_worker";
    },
    Effect.orElseSucceed(() => "issue_suspended" as const),
  );
  // Former workers cannot accept new work; usage-limit retries remain quiet until admission.
  const guardFormerWorkerMessage = Effect.fn("guardFormerWorkerMessage")(function* (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>,
    thread: OrchestrationV2AppThread,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const issue = thread.linkedIssue;
    if (
      issue === undefined ||
      isUnmanagedIssueRole(thread.role) ||
      Option.isNone(issueWorkStore) ||
      command.delegatedCompletion !== undefined ||
      command.usageLimitContinuationOfRunId !== undefined ||
      command.automaticProviderContinuationOfRunId !== undefined ||
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
    const ownerShell = yield* projectionStore.getThreadShell(owner).pipe(mapDispatchError(command));
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      detail: `Issue #${issue.number} is now worked by another thread${ownerShell ? ` ("${ownerShell.title}")` : ""}, ${owner}. Delegate a new task for the issue, or send this to that thread if it should do the work.`,
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
    const config = yield* store.configuration(command.threadId).pipe(mapDispatchError(command));
    if (config === null || !repositoryAdmitsWork(config) || repositoryPhase(config) === "draining")
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "The repository root is unavailable or transferring ownership.",
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
    if (
      read === undefined ||
      !issueAdmissionEligible(read) ||
      (yield* store.hasPendingOpening(command.issue).pipe(mapDispatchError(command)))
    )
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Only unheld Todo issues with complete, unblocked relationships can start.",
      });
    if (read.parent !== null && !sameIssueRepository(read.parent, command.issue))
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        detail: issueScopeExpansionError,
      });
    const owner = yield* store.issueOwner(command.issue).pipe(mapDispatchError(command));
    let issueThreadId: ThreadId | null = null;
    let retainedOwner: ThreadId | null = null;
    if (
      command.automatic === true &&
      (yield* store.slotsInUse(command.threadId).pipe(mapDispatchError(command))) >=
        config.workerLimit
    )
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "No repository worker slot is available.",
      });
    if (command.automatic === true && owner !== null)
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "An issue worker already holds this claim.",
      });
    if (command.automatic === true && Option.isSome(issueWorkStore)) {
      const queue = yield* issueWorkStore.value
        .queue(command.issue)
        .pipe(mapDispatchError(command));
      const candidateIndex = queue.findIndex(
        ({ issue }) => sameIssueRepository(issue, command.issue) && issue.id === command.issue.id,
      );
      const priorityQueue = candidateIndex < 0 ? queue : queue.slice(0, candidateIndex);
      const reads = yield* IssueReadSnapshots;
      const queuedSnapshot = yield* IssueQueueSnapshot;
      for (const queued of priorityQueue) {
        if (!queuedSnapshot.has(issueKey(queued.issue)))
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "A queued issue changed during admission; retry after refreshing its status.",
          });
        const queuedRead = reads.find(
          (read) =>
            sameIssueRepository(read.issue, queued.issue) && read.issue.id === queued.issue.id,
        );
        if (queuedRead === undefined) continue;
        if (
          !issueAdmissionEligible(queuedRead) ||
          (yield* issueWorkStore.value
            .hasPendingOpening(queued.issue)
            .pipe(mapDispatchError(command))) ||
          config.suspendedIssues.some((entry) => entry.id === queued.issue.id) ||
          (queuedRead.parent !== null &&
            (!sameIssueRepository(queuedRead.parent, queued.issue) ||
              (yield* issueWorkStore.value
                .currentIssueOwner(queuedRead.parent)
                .pipe(mapDispatchError(command))) === null))
        )
          continue;
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Queued issues have priority over unqueued Todo issues.",
        });
      }
    }
    if (owner !== null) {
      const current = yield* projectionStore
        .getThreadRecords(owner, ["runs", "messages", "subagents"])
        .pipe(mapDispatchError(command));
      const shell = yield* projectionStore.getThreadShell(owner).pipe(mapDispatchError(command));
      if (keepIssueWorktree(current.thread)) retainedOwner = owner;
      if (
        delegatedTaskProgress({
          ...current,
          pendingBackgroundTasks: shell?.pendingBackgroundTasks ?? [],
        }).state !== "result_available"
      )
        issueThreadId = owner;
    }
    const attemptKey =
      issueThreadId === null && retainedOwner === null
        ? (owner ?? "first")
        : `active:${issueThreadId ?? retainedOwner}`;
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
        ...(command.workerRole === undefined ? {} : { workerRole: command.workerRole }),
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
    const codexRoleSpeed =
      workerAdapter.driver === "codex"
        ? codexRoleSpeedFromSelection(command.workerModelSelection)
        : undefined;
    yield* dispatchDelegatedTaskRequest(
      {
        type: "delegated_task.request",
        commandId: command.commandId,
        parentThreadId: recipientId,
        parentRunId: null,
        parentNodeId: null,
        issue: command.issue,
        task:
          command.workerRole === "designer" || command.workerRole === "writer"
            ? `Work as the ${command.workerRole} on issue #${command.issue.number}: ${command.issue.title}
${command.issue.url}
Read the issue and comments, produce the requested deliverable, and report when it is ready for review.`
            : issueWorkerBrief(
                command.issue,
                command.issueWorktree !== undefined &&
                  isDraftPrRepository(draftPrRepositories, command.issue),
              ),
        ...(command.workerRole === undefined ? {} : { role: command.workerRole }),
        modelSelection: command.workerModelSelection,
        ...(codexRoleSpeed === undefined ? {} : { codexRoleSpeed }),
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
    const childThreadId =
      retainedOwner ?? idAllocator.derive.delegatedTaskThread({ commandId: command.commandId });
    yield* Ref.update(events, (pending) =>
      pending.map((event) =>
        event.type === "issue.work.requested" && event.payload.requestId === command.commandId
          ? { ...event, payload: { ...event.payload, issueThreadId: childThreadId } }
          : event,
      ),
    );
  });

  const reuseManagedChild = Effect.fn("reuseManagedChild")(function* (
    request: DelegatedTaskRequest,
    parentProjection: ProjectionRecords<never>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    command: OrchestrationV2ServerCommand,
  ) {
    if (isUnmanagedIssueRole(request.role)) return false;
    const parent = parentProjection.thread;
    const root =
      parent.lineage.rootThreadId === parent.id
        ? parent
        : yield* projectionStore
            .getThread(parent.lineage.rootThreadId)
            .pipe(mapDispatchError(command));
    const managed = requiresManagedIssueAdmission(request.role, parent, root);
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
      const repositoryConfig =
        repositoryOwner === null
          ? null
          : yield* issueStore
              .configuration(repositoryOwner.rootThreadId)
              .pipe(mapDispatchError(command));
      if (
        repositoryOwner === null ||
        repositoryConfig === null ||
        !repositoryAdmitsWork(repositoryConfig) ||
        repositoryPhase(repositoryConfig) === "draining"
      )
        return yield* new OrchestratorDispatchError({
          commandId: request.commandId,
          commandType: request.type,
          cause: "The repository root is unavailable or transferring ownership.",
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
      if (
        currentOwner === null &&
        (!issueAdmissionEligible(read) ||
          (yield* issueStore.hasPendingOpening(request.issue).pipe(mapDispatchError(command))))
      )
        return yield* new OrchestratorDispatchError({
          commandId: request.commandId,
          commandType: request.type,
          cause: "Only unheld Todo issues can claim a new worker.",
        });
      if (currentOwner !== null) {
        const current = yield* projectionStore
          .getThreadRecords(currentOwner, ["runs", "messages", "subagents"])
          .pipe(mapDispatchError(command));
        const shell = yield* projectionStore
          .getThreadShell(currentOwner)
          .pipe(mapDispatchError(command));
        const retained = keepIssueWorktree(current.thread);
        const historical = current.thread.lineage.rootThreadId !== repositoryOwner.rootThreadId;
        // Messages stranded by the old lineage can start once the worker is adopted.
        const finished =
          delegatedTaskProgress({
            ...current,
            runs:
              retained && historical
                ? current.runs.filter(
                    (run) => run.status !== "queued" || run.admissionWait !== "not_current_worker",
                  )
                : current.runs,
            pendingBackgroundTasks: shell?.pendingBackgroundTasks ?? [],
          }).state === "result_available";
        if (
          finished &&
          !retained &&
          (!issueAdmissionEligible(read) ||
            (yield* issueStore.hasPendingOpening(request.issue).pipe(mapDispatchError(command))))
        )
          return yield* new OrchestratorDispatchError({
            commandId: request.commandId,
            commandType: request.type,
            cause: "Only unheld Todo issues can start a successor worker.",
          });
        if (!finished || retained) {
          const parent = current.thread.lineage.parentThreadId;
          const existing =
            parent === null
              ? undefined
              : (yield* projectionStore
                  .getThreadRecords(parent, ["subagents"], {
                    subagentChildThreadIds: [currentOwner],
                  })
                  .pipe(mapDispatchError(command))).subagents.findLast(
                  (task) => task.childThreadId === currentOwner,
                );
          const sameParent = !historical && existing?.threadId === request.parentThreadId;
          const adopting =
            !sameParent &&
            finished &&
            existing !== undefined &&
            isSettledIssueWorkerTask(existing) &&
            (yield* adoptionLineage(current.thread).pipe(mapDispatchError(command)))
              ?.parentThreadId === request.parentThreadId;
          if (existing === undefined || (!sameParent && !adopting))
            return yield* new OrchestratorDispatchError({
              commandId: request.commandId,
              commandType: request.type,
              cause:
                "This issue already has a current worker under another parent. Read its issue status and use that parent thread to manage it.",
            });
          if (
            adopting &&
            exceededDispatchModeLimit(parentProjection.thread, current.thread) !== undefined
          )
            return yield* new OrchestratorDispatchError({
              commandId: request.commandId,
              commandType: request.type,
              detail: "The existing issue worker's modes exceed the new parent's modes.",
            });
          if (
            request.enableTools !== undefined &&
            !Equal.equals(
              toolAdditionKeys(request.enableTools),
              toolAdditionKeys(current.thread.enableTools ?? []),
            )
          )
            return yield* new OrchestratorDispatchError({
              commandId: request.commandId,
              commandType: request.type,
              detail: "The existing issue worker keeps its original tool selection.",
            });
          if (finished) {
            const message = {
              type: "message.dispatch",
              commandId: request.commandId,
              threadId: currentOwner,
              senderThreadId: request.parentThreadId,
              messageId: MessageId.make(`issue-resume:${request.commandId}`),
              text: request.task,
              attachments: [],
              modelSelection: request.modelSelection,
              dispatchMode: { type: "start_immediately" },
              createdBy: request.createdBy,
              creationSource: request.creationSource,
            } satisfies Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>;
            yield* dispatchMessage(message, events, effects);
            yield* recordSubagentFollowup(message, events);
            return true;
          }
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

  // Commit owns the claim; this only starts already queued, committed runs.
  const continueAdmissions = Effect.fnUntraced(function* <E, R>(
    command: OrchestrationV2ServerCommand,
    storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>,
    startNextQueuedRun: (id: ThreadId) => Effect.Effect<void, E, R>,
  ) {
    for (const stored of storedEvents) {
      if (stored.event.type !== "run.created" || stored.event.payload.status !== "queued") continue;
      // The thread row alone: a shell read walks the thread's history for fields unused here.
      const thread = yield* projectionStore
        .getThread(stored.event.threadId)
        .pipe(mapDispatchError(command));
      if (
        thread.deletedAt === null &&
        (thread.linkedIssue !== undefined || isReadOnlyIssueRole(thread.role))
      )
        yield* mapDispatchError(command)(startNextQueuedRun(stored.event.threadId));
    }
  });

  // Delegation owns the surrounding span and adapter lookup order.
  const guardDelegatedProvider = Effect.fnUntraced(function* (
    request: DelegatedTaskRequest,
    driver: ProviderDriverKind,
  ) {
    if (request.issue !== undefined && !supportsManagedIssueWork(driver))
      return yield* new OrchestratorDispatchError({
        commandId: request.commandId,
        commandType: request.type,
        detail: managedIssueProviderError,
      });
  });

  // The claim's link replaces links the child inherited from its parent's thread.
  const childIssueFields = (
    request: DelegatedTaskRequest,
    projectId: ProjectId,
    now: DateTime.Utc,
  ) => ({
    ...(request.issue === undefined
      ? {}
      : { ...claimFields(request.issue, projectId, now), titleSource: "generated" as const }),
    ...(request.role === undefined ? {} : { role: request.role }),
  });

  // A child with its own worktree has no checkout until its deferred run's
  // preparation binds one; it never borrows the parent's.
  const childWorkspaceFields = (request: DelegatedTaskRequest) =>
    request.workspaceStrategy === undefined
      ? request.issue === undefined || isUnmanagedIssueRole(request.role)
        ? {}
        : { branch: null, worktreePath: null }
      : { branch: request.workspaceStrategy.branch ?? null, worktreePath: null };

  const closeOut = Effect.fn("IssueWorkCommands.closeOut")(function* (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "issue.work.close-out" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const read = yield* issueSnapshot(command.issue);
    if (read?.state !== "closed")
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        detail: "Only a confirmed closed issue can be closed out.",
      });
    for (const event of yield* issueWorkRecovery.closeOut(command).pipe(mapDispatchError(command)))
      yield* emit(events, command)<OrchestrationV2DomainEvent>(event);
  });

  const cancel = Effect.fn("cancel")(function* (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "issue.work.cancel" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    for (const event of yield* issueWorkRecovery.cancel(command).pipe(mapDispatchError(command)))
      yield* emit(events, command)<OrchestrationV2DomainEvent>(event);
  });

  // Thread creation's enclosing dispatch span owns this validation.
  const guardThreadCreate = Effect.fnUntraced(function* (
    command: Extract<OrchestrationV2Command, { type: "thread.create" }>,
  ) {
    if (command.linkedIssue !== undefined) {
      const adapter = yield* providerAdapters
        .get(command.modelSelection.instanceId)
        .pipe(mapDispatchError(command));
      if (!supportsManagedIssueWork(adapter.driver)) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          detail: managedIssueProviderError,
        });
      }
    }
  });

  return {
    guardThreadCreate,
    admissionWait: issueRunAdmissionWait,
    adoptionLineage,
    guardFormerWorkerMessage,
    start,
    reuseManagedChild,
    guardDelegatedProvider,
    continueAdmissions,
    childIssueFields,
    childWorkspaceFields,
    closeOut,
    cancel,
  };
}
