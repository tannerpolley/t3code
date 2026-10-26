import {
  DEFAULT_REPOSITORY_WORK_SETTINGS,
  isRepositoryOrchestratorEligible,
  type IssueWorkRequested,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type RepositoryOrchestration,
} from "@t3tools/contracts";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";

type Command<Type extends OrchestrationV2ServerCommand["type"]> = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: Type }
>;
type EventInput<Event = OrchestrationV2DomainEvent> = Event extends unknown
  ? Omit<Event, "id">
  : never;

const topLevelTargetError =
  "Select an existing active top-level thread in the same repository project.";

/**
 * Issue recovery decisions: cancel an unclaimed admission, close out a stopped attempt, or
 * register or restore a repository orchestrator. The orchestrator owns locks, receipts and event ids. These read
 * committed state and fail with the user-facing rejection reason as a string.
 */
export const makeIssueWorkRecovery = Effect.gen(function* () {
  const projectionStore = yield* ProjectionStoreV2;
  const providerAdapters = yield* ProviderAdapterRegistryV2;
  const issueWorkStore = yield* Effect.serviceOption(IssueWorkStore.IssueWorkStore);
  const requireStore = Effect.fromOption(issueWorkStore).pipe(
    Effect.mapError(() => "Issue ownership service is unavailable."),
  );

  /**
   * Restore locks both roots. Lineage never changes, so a non-top-level thread is refused before
   * locking: a child follow-up holds its parent's lock first, and taking a child before its root
   * would deadlock against it. A missing thread is refused too, since one created as a child
   * between this read and the locked one would skip the lineage check.
   */
  const restoreLockKeys = Effect.fn("restoreLockKeys")(function* (
    command: Command<"repository.work.restore">,
  ) {
    const keys = [...new Set([command.threadId, command.targetThreadId])].sort();
    for (const threadId of keys) {
      const shell = yield* projectionStore.getThreadShell(threadId);
      if (
        shell === null ||
        shell.lineage.parentThreadId !== null ||
        shell.lineage.rootThreadId !== shell.id
      )
        return yield* Effect.fail(topLevelTargetError);
    }
    return keys;
  });

  const cancel = Effect.fn("cancel")(function* (command: Command<"issue.work.cancel">) {
    const store = yield* requireStore;
    const request = yield* store.request(command.requestId);
    const root = yield* projectionStore.getThread(command.threadId);
    if (
      request === null ||
      request.rootThreadId !== command.threadId ||
      root.projectId !== command.projectId ||
      root.repositoryOrchestration?.projectId !== command.projectId ||
      request.issue.host !== root.repositoryOrchestration.host ||
      request.issue.repositoryId !== root.repositoryOrchestration.repositoryId
    )
      return yield* Effect.fail(
        "The request does not belong to the selected repository root and project.",
      );
    const occurredAt = yield* DateTime.now;
    const cancelled = (
      pending: IssueWorkRequested,
      cancellation: NonNullable<IssueWorkRequested["cancellation"]>,
    ): EventInput => ({
      type: "issue.work.cancelled",
      threadId: command.threadId,
      occurredAt,
      payload: {
        requestedRequestId: command.requestId,
        requestId: pending.requestId,
        issue: pending.issue,
        cancellation,
      },
    });
    if (request.cancellation !== undefined) return [cancelled(request, request.cancellation)];
    const repository = yield* store.repositoryOwner(request.issue);
    const owner = yield* store.issueOwner(request.issue);
    const previousAttempt =
      owner === null
        ? null
        : yield* projectionStore.getThreadRecords(owner, ["runs", "messages", "subagents"]);
    const shell = owner === null ? null : yield* projectionStore.getThreadShell(owner);
    if (
      repository?.rootThreadId !== command.threadId ||
      request.issueThreadId !== null ||
      (owner !== null &&
        (request.attemptKey !== owner ||
          previousAttempt === null ||
          delegatedTaskProgress({
            ...previousAttempt,
            pendingBackgroundTasks: shell?.pendingBackgroundTasks ?? [],
          }).state !== "result_available"))
    )
      return yield* Effect.fail(
        "Only an unclaimed issue start request can be cancelled; claimed worker work must be handled explicitly.",
      );
    const cancellation = {
      commandId: command.commandId,
      reason: command.reason,
      cancelledAt: DateTime.formatIso(occurredAt),
    };
    // Duplicate Start clicks authorize one admission, so release all coalesced receipts.
    return (yield* store.requestsForAttempt(request)).map((pending) =>
      cancelled(pending, cancellation),
    );
  });

  /**
   * Run `retiringRoot` through the root lifecycle guard before committing the events. The
   * registration event carries the owner: compaction keeps only each thread's newest snapshot.
   */
  const restore = Effect.fn("restore")(function* (command: Command<"repository.work.restore">) {
    const store = yield* requireStore;
    const owner = yield* store.repositoryOwner(command);
    const target = yield* projectionStore.getThread(command.targetThreadId);
    const targetConfig = target.repositoryOrchestration;
    const adapter = yield* providerAdapters.get(target.modelSelection.instanceId);
    if (!isRepositoryOrchestratorEligible(target, adapter.driver, command))
      return yield* Effect.fail(topLevelTargetError);
    const occurredAt = yield* DateTime.now;
    let retiringRoot: OrchestrationV2AppThread | null = null;
    let config: RepositoryOrchestration;
    if (command.expectedRootThreadId === null) {
      if (
        owner !== null ||
        command.expectedRevision !== null ||
        command.threadId !== target.id ||
        targetConfig !== undefined
      )
        return yield* Effect.fail(
          "A repository orchestrator is already registered. Refresh ownership before registering a lead.",
        );
      config = {
        host: command.host,
        repository: command.repository,
        repositoryId: command.repositoryId,
        projectId: command.projectId,
        launchCommandId: command.commandId,
        revision: 1,
        paused: false,
        ...DEFAULT_REPOSITORY_WORK_SETTINGS,
        milestones: [],
        suspendedIssues: [],
      };
    } else {
      const shell = yield* projectionStore.getThread(command.threadId);
      const prior = shell.repositoryOrchestration;
      if (
        prior === undefined ||
        prior.retiredToThreadId !== undefined ||
        command.expectedRootThreadId !== shell.id ||
        shell.id === target.id ||
        owner?.rootThreadId !== shell.id ||
        owner.revision !== command.expectedRevision ||
        prior.revision !== command.expectedRevision ||
        prior.host !== command.host ||
        prior.repositoryId !== command.repositoryId ||
        prior.repository.toLowerCase() !== command.repository.toLowerCase() ||
        prior.projectId !== command.projectId ||
        shell.projectId !== command.projectId ||
        owner.projectId !== command.projectId
      )
        return yield* Effect.fail(
          "Repository ownership changed. Refresh the registered root and revision before restoring.",
        );
      if (!prior.paused)
        return yield* Effect.fail("Pause repository work before restoring its owner.");
      retiringRoot = shell;
      config = {
        ...prior,
        handoff: undefined,
        retiredToThreadId: undefined,
        launchCommandId: command.commandId,
        revision: prior.revision + 1,
        handoffHistory: [
          ...(prior.handoffHistory ?? []),
          { threadId: shell.id, transferredAt: DateTime.formatIso(occurredAt) },
        ],
      };
    }
    const events: Array<EventInput> = [
      {
        type: "repository.work.restored",
        threadId: target.id,
        occurredAt,
        payload: {
          previousRootThreadId: command.expectedRootThreadId,
          targetThreadId: target.id,
          expectedRevision: command.expectedRevision,
          reason: command.reason,
          repositoryOrchestration: config,
        },
      },
    ];
    if (retiringRoot?.repositoryOrchestration !== undefined)
      events.push({
        type: "thread.metadata-updated",
        threadId: retiringRoot.id,
        occurredAt,
        payload: {
          ...retiringRoot,
          repositoryOrchestration: {
            ...retiringRoot.repositoryOrchestration,
            retiredToThreadId: target.id,
          },
          updatedAt: occurredAt,
        },
      });
    events.push({
      type: "thread.metadata-updated",
      threadId: target.id,
      occurredAt,
      payload: {
        ...target,
        repositoryOrchestration: config,
        updatedAt: occurredAt,
      },
    });
    return { retiringRoot, events };
  });

  const closeOut = Effect.fn("IssueWorkRecovery.closeOut")(function* (
    command: Command<"issue.work.close-out">,
  ) {
    const store = yield* requireStore;
    const root = yield* projectionStore.getThread(command.threadId);
    const config = root.repositoryOrchestration;
    const repository = yield* store.repositoryOwner(command.issue);
    if (
      config === undefined ||
      config.revision !== command.expectedRevision ||
      config.handoff?.status === "draining" ||
      repository?.rootThreadId !== command.threadId ||
      (yield* store.issueOwner(command.issue)) !== command.issueThreadId
    )
      return yield* Effect.fail(
        "Repository ownership or the issue attempt changed. Refresh before closing out.",
      );
    const child = yield* projectionStore.getThreadRecords(command.issueThreadId, [
      "runs",
      "subagents",
      "runtimeRequests",
      "providerThreads",
      "turnItems",
    ]);
    const terminal = (status: string) =>
      ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(status);
    if (
      child.thread.lineage.rootThreadId !== root.id ||
      child.runs.some((run) => !terminal(run.status)) ||
      child.subagents.some((task) => !terminal(task.status)) ||
      child.runtimeRequests.some((request) => request.status === "pending") ||
      child.providerThreads.some(
        (provider) => (provider.pendingBackgroundTasks?.length ?? 0) > 0,
      ) ||
      child.turnItems.some(
        (item) =>
          !terminal(item.status) &&
          !(item.type === "command_execution" && item.input === "Preparing workspace"),
      ) ||
      (yield* store.hasUnsettledRestartContinuation(command.issueThreadId))
    )
      return yield* Effect.fail(
        "Cancel or finish the attempt's remaining work before closing it out.",
      );
    const parentId = child.thread.lineage.parentThreadId;
    if (parentId === null) return yield* Effect.fail("The issue attempt has no parent.");
    const parent = yield* projectionStore.getThreadRecords(parentId, [
      "subagents",
      "nodes",
      "turnItems",
    ]);
    const task = parent.subagents.findLast(
      (task) => task.origin === "app_owned" && task.childThreadId === command.issueThreadId,
    );
    if (task === undefined) return yield* Effect.fail("The issue attempt has no delegated task.");
    const now = yield* DateTime.now;
    const events: EventInput[] = [];
    for (const item of child.turnItems) {
      if (
        item.type !== "command_execution" ||
        item.input !== "Preparing workspace" ||
        terminal(item.status)
      )
        continue;
      events.push({
        type: "turn-item.updated",
        threadId: child.thread.id,
        occurredAt: now,
        payload: { ...item, status: "cancelled", completedAt: now, updatedAt: now },
      });
    }
    for (const nested of child.subagents) {
      if (
        nested.origin !== "app_owned" ||
        (nested.completionDelivery?.state !== "pending" &&
          nested.completionDelivery?.state !== "claimed")
      )
        continue;
      events.push({
        type: "subagent.updated",
        threadId: child.thread.id,
        nodeId: nested.id,
        occurredAt: now,
        payload: {
          ...nested,
          updatedAt: now,
          completionDelivery: { state: "disposed", observedByRunId: null },
        },
      });
    }
    const result = task.result ?? "Closed out the attempt for the closed issue.";
    events.push({
      type: "subagent.updated",
      threadId: parentId,
      nodeId: task.id,
      occurredAt: now,
      payload: {
        ...task,
        status: "completed",
        result,
        completedAt: task.completedAt ?? now,
        updatedAt: now,
        completionDelivery: { state: "disposed", observedByRunId: null },
      },
    });
    const node = parent.nodes.find((node) => node.id === task.id);
    if (node !== undefined)
      events.push({
        type: "node.updated",
        threadId: parentId,
        nodeId: node.id,
        occurredAt: now,
        payload: { ...node, status: "completed", completedAt: node.completedAt ?? now },
      });
    for (const item of parent.turnItems) {
      if (item.type !== "subagent" || item.subagentId !== task.id) continue;
      events.push({
        type: "turn-item.updated",
        threadId: parentId,
        occurredAt: now,
        payload: {
          ...item,
          status: "completed",
          result,
          completedAt: item.completedAt ?? now,
          updatedAt: now,
        },
      });
    }
    events.push({
      type: "thread.metadata-updated",
      threadId: root.id,
      occurredAt: now,
      payload: {
        ...root,
        updatedAt: now,
        repositoryOrchestration: {
          ...config,
          revision: config.revision + 1,
          suspendedIssues: config.suspendedIssues.filter((entry) => entry.id !== command.issue.id),
        },
      },
    });
    return events;
  });

  return { restoreLockKeys, cancel, restore, closeOut };
});
