/**
 * Background work a released session's process left running. Release clears the
 * session's background roster; nothing will report the end of its open
 * commands, dynamic tools and subagents either, such as a tool call a workspace
 * handoff cut off. A delegate_task child is a thread of its own and ends on
 * its own. Items started after the release belong to a replacement session.
 */
import type {
  EventId,
  OrchestrationV2DomainEvent,
  ProviderDriverKind,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { pendingBackgroundTurnItems } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { EventSinkV2Shape } from "./EventSink.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

export const endReleasedSessionWork = <E>(input: {
  readonly projections: Pick<ProjectionStoreV2Shape, "getThreadRecords">;
  readonly eventSink: Pick<EventSinkV2Shape, "write">;
  readonly allocateEventId: (threadId: ThreadId) => Effect.Effect<EventId, E>;
  readonly driver: ProviderDriverKind;
  /** The released session's provider threads, by the app thread that holds each. */
  readonly providerThreads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
  }>;
  readonly releasedAt: DateTime.Utc;
}) =>
  Effect.forEach(
    Map.groupBy(input.providerThreads, ({ threadId }) => threadId),
    ([threadId, providerThreads]) =>
      Effect.gen(function* () {
        const providerThreadIds = new Set(providerThreads.map((entry) => entry.providerThreadId));
        const { turnItems } = yield* input.projections.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
          turnItemStatuses: ["pending", "running", "waiting"],
        });
        const released = pendingBackgroundTurnItems({ turnItems }).filter(
          (item) =>
            item.providerThreadId != null &&
            providerThreadIds.has(item.providerThreadId) &&
            !(item.type === "subagent" && item.origin === "app_owned") &&
            !DateTime.isGreaterThan(item.startedAt ?? item.updatedAt, input.releasedAt),
        );
        if (released.length === 0) return;
        const now = yield* DateTime.now;
        const allocateEventId = () => input.allocateEventId(threadId);
        const events: Array<OrchestrationV2DomainEvent> = [];
        for (const item of released) {
          events.push({
            id: yield* allocateEventId(),
            type: "turn-item.updated",
            threadId,
            ...(item.runId === null ? {} : { runId: item.runId }),
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            driver: input.driver,
            occurredAt: now,
            payload: { ...item, status: "interrupted", completedAt: now, updatedAt: now },
          });
        }
        yield* input.eventSink.write({ events });
      }),
    { discard: true },
  );
