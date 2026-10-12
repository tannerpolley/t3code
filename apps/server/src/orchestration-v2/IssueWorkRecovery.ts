import {
  DEFAULT_REPOSITORY_WORK_SETTINGS,
  isProviderNativeSubagentThread,
  type IssueWorkRequested,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type RepositoryOrchestration,
} from "@t3tools/contracts";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { managedIssueProviderError, supportsManagedIssueWork } from "../issues/IssueEligibility.ts";
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
 * User-only issue recovery decisions: cancel an unclaimed admission, and register or restore a
 * repository orchestrator. The orchestrator owns locks, receipts and event ids. These read
 * committed state and fail with the user-facing rejection reason as a string.
 */
export const makeIssueWorkRecovery = Effect.gen(function* () {
  const projectionStore = yield* ProjectionStoreV2;
  const providerAdapters = yield* ProviderAdapterRegistryV2;
  const issueWorkStore = yield* Effect.serviceOption(IssueWorkStore.IssueWorkStore);
  const requireStore = Option.match(issueWorkStore, {
    onNone: () => Effect.fail("Issue ownership service is unavailable."),
    onSome: Effect.succeed,
  });

  /**
   * Restore locks both roots. Lineage never changes, so a non-top-level thread is refused before
   * locking: a child follow-up holds its parent's lock first, and taking a child before its root
   * would deadlock against it.
   */
  const restoreLockKeys = (command: Command<"repository.work.restore">) =>
    Effect.gen(function* () {
      const keys = [...new Set([command.threadId, command.targetThreadId])].sort();
      for (const threadId of keys) {
        const shell = yield* projectionStore.getThreadShell(threadId);
        if (
          shell !== null &&
          (shell.lineage.parentThreadId !== null || shell.lineage.rootThreadId !== shell.id)
        )
          return yield* Effect.fail(topLevelTargetError);
      }
      return keys;
    });

  const cancel = (command: Command<"issue.work.cancel">) =>
    Effect.gen(function* () {
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
  const restore = (command: Command<"repository.work.restore">) =>
    Effect.gen(function* () {
      const store = yield* requireStore;
      const owner = yield* store.repositoryOwner(command);
      const target = yield* projectionStore.getThread(command.targetThreadId);
      const targetConfig = target.repositoryOrchestration;
      if (
        target.projectId !== command.projectId ||
        target.deletedAt !== null ||
        target.archivedAt !== null ||
        target.linkedIssue !== undefined ||
        isProviderNativeSubagentThread(target) ||
        (targetConfig !== undefined &&
          (targetConfig.host !== command.host ||
            targetConfig.repositoryId !== command.repositoryId ||
            targetConfig.projectId !== command.projectId))
      )
        return yield* Effect.fail(topLevelTargetError);
      const adapter = yield* providerAdapters.get(target.modelSelection.instanceId);
      if (!supportsManagedIssueWork(adapter.driver))
        return yield* Effect.fail(managedIssueProviderError);
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
          workspace: target.worktreePath === null ? "project" : "worktree",
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
        payload: { ...target, repositoryOrchestration: config, updatedAt: occurredAt },
      });
      return { retiringRoot, events };
    });

  return { restoreLockKeys, cancel, restore };
});
