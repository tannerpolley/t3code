/**
 * Turn items that cannot outlive their run end with it. A provider normally ends
 * them before its turn ends, but not when its session detaches or crashes
 * mid-turn, and some never send an end (Codex's turn plan). Commands, dynamic
 * tools and subagents can keep running as background work after the turn, so
 * they keep their own endings: provider events, Stop, session release and
 * startup recovery.
 */
import {
  EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type TurnItemId,
} from "@t3tools/contracts";
import { isBackgroundTurnItemType } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

type EndedRunStatus = Extract<
  OrchestrationV2Run["status"],
  "completed" | "failed" | "interrupted" | "cancelled"
>;

export function isEndedRunStatus(status: OrchestrationV2Run["status"]): status is EndedRunStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled"
  );
}

/** Whether `item` is still running although it cannot outlive its run. */
export function isTurnBoundItemOpen(item: OrchestrationV2TurnItem): boolean {
  return item.status === "running" && !isBackgroundTurnItemType(item.type);
}

/** `item` ended with its run: completed when the run completed, otherwise interrupted. */
export function endTurnItem(
  item: OrchestrationV2TurnItem,
  runStatus: EndedRunStatus,
  endedAt: DateTime.Utc,
): OrchestrationV2TurnItem {
  return {
    ...item,
    ...("streaming" in item ? { streaming: false } : {}),
    status: runStatus === "completed" ? "completed" : "interrupted",
    completedAt: endedAt,
    updatedAt: endedAt,
  };
}

/**
 * Appends an end for every turn-bound item a run in `events` leaves running as
 * it ends, so the run and its items commit together whichever path ended it.
 */
export const endTurnItemsOfEndedRuns = (
  projections: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) =>
  Effect.gen(function* () {
    const endedRuns = events.flatMap((event) =>
      event.type === "run.updated" && isEndedRunStatus(event.payload.status)
        ? [{ event, run: event.payload, status: event.payload.status }]
        : [],
    );
    if (endedRuns.length === 0) return events;
    // The newest version of each item, this batch's writes over stored rows.
    const written = new Map<TurnItemId, OrchestrationV2TurnItem>();
    for (const event of events) {
      if (event.type === "turn-item.updated") written.set(event.payload.id, event.payload);
    }
    const ended: Array<OrchestrationV2DomainEvent> = [];
    for (const { event, run, status } of endedRuns) {
      const stored = yield* projections
        .getThreadRecords(run.threadId, ["turnItems"], {
          turnItemRunId: run.id,
          turnItemStatuses: ["running"],
        })
        .pipe(
          Effect.map(({ turnItems }) => turnItems),
          // A thread created in this same batch has no stored items yet.
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed([]) }),
        );
      const candidates = new Map(stored.map((item) => [item.id, item]));
      for (const item of written.values()) if (item.runId === run.id) candidates.set(item.id, item);
      for (const candidate of candidates.values()) {
        const item = written.get(candidate.id) ?? candidate;
        if (item.runId !== run.id || !isTurnBoundItemOpen(item)) continue;
        const payload = endTurnItem(item, status, event.occurredAt);
        written.set(item.id, payload);
        ended.push({
          id: EventId.make(`${event.id}:turn-item-ended:${item.id}`),
          type: "turn-item.updated",
          threadId: run.threadId,
          runId: run.id,
          ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: event.occurredAt,
          payload,
        });
      }
    }
    return ended.length === 0 ? events : [...events, ...ended];
  });
