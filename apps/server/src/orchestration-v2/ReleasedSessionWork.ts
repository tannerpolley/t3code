/**
 * Background work a released session's process left running. Release clears the
 * session's background roster; nothing will report the end of its open
 * commands, dynamic tools and subagents either, such as a tool call a workspace
 * handoff cut off. A native subagent ends with its record, node and child
 * thread's work. A delegate_task child is a thread of its own and ends on its
 * own. Items started after the release belong to a replacement session.
 */
import type {
  EventId,
  OrchestrationV2DomainEvent,
  ProviderDriverKind,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import {
  endOrphanedNativeSubagent,
  endRunlessRootTurns,
} from "@t3tools/provider-core/server/subagentProjection";
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
        const nativeSubagents = released.flatMap((item) =>
          item.type === "subagent" && item.origin === "provider_native" ? [item] : [],
        );
        if (nativeSubagents.length > 0) {
          const { nodes, subagents } = yield* input.projections.getThreadRecords(threadId, [
            "nodes",
            "subagents",
          ]);
          for (const item of nativeSubagents) {
            events.push(
              ...(yield* endOrphanedNativeSubagent({
                projection: { nodes, subagents, turnItems },
                subagentId: item.subagentId,
                status: "interrupted",
                now,
                emitted: events,
                allocateEventId,
              })),
            );
            if (item.childThreadId === null) continue;
            const child = yield* input.projections
              .getThreadRecords(item.childThreadId, ["nodes", "turnItems"], {
                turnItemRunIds: [null],
                turnItemStatuses: ["pending", "running", "waiting"],
              })
              .pipe(
                Effect.catchTags({
                  ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
                }),
              );
            if (child === null) continue;
            events.push(
              ...(yield* endRunlessRootTurns({
                threadId: item.childThreadId,
                providerInstanceId: item.providerInstanceId,
                projection: child,
                status: "interrupted",
                now,
                emitted: events,
                allocateEventId,
              })),
            );
          }
        }
        const ended = new Set(
          events.flatMap((event) => (event.type === "turn-item.updated" ? [event.payload.id] : [])),
        );
        for (const item of released) {
          if (ended.has(item.id)) continue;
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
