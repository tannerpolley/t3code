import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { threadQuietMinutes } from "@t3tools/shared/threadActivity";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { quietActivitySamplingWindowMs } from "../persistence/ForkMigrations/032_QuietThreadActivity.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { Scheduler } from "../scheduling/Scheduler.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler;
    const random = yield* SecureRandom.SecureRandom;
    const projections = yield* ProjectionStoreV2;
    const events = yield* EventSinkV2;
    const settings = yield* ServerSettingsService;
    const threads = yield* ThreadManagementService;
    let delivered = new Map<ThreadId, string>();

    yield* scheduler.register(
      "quiet-delegates",
      Effect.gen(function* () {
        const candidates = yield* projections.getQuietActivityCandidates();
        const clock = {
          nowMs: yield* Clock.currentTimeMillis,
          samplingWindowMs: quietActivitySamplingWindowMs,
          quietMinutes: (yield* settings.getSettings).quietThreadMinutes,
        };
        const threadsWithActivity = candidates.map((thread) => ({
          thread,
          quietMinutes: threadQuietMinutes(thread, clock),
        }));
        const changes: OrchestrationV2DomainEvent[] = [];
        for (const { thread, quietMinutes } of threadsWithActivity) {
          const lastProviderActivityAt =
            quietMinutes === null ? null : thread.lastProviderActivityAt;
          if (thread.quietActivityAt === lastProviderActivityAt) continue;
          changes.push({
            id: EventId.make(yield* random.uuidV4()),
            type: "thread.quiet-updated",
            threadId: thread.threadId,
            occurredAt: DateTime.makeUnsafe(clock.nowMs),
            payload: { runId: thread.runId, lastProviderActivityAt },
          });
        }
        if (changes.length > 0) yield* events.write({ events: changes });

        const stillDelivered = new Map<ThreadId, string>();
        for (const { thread: child, quietMinutes } of threadsWithActivity) {
          if (quietMinutes === null || child.parentThreadId === null) continue;

          const key = `quiet-delegate:${child.threadId}:${child.runId}:${child.lastProviderActivityAt}`;
          if (delivered.get(child.threadId) === key) {
            stillDelivered.set(child.threadId, key);
            continue;
          }
          yield* threads
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(key),
              threadId: child.parentThreadId,
              messageId: MessageId.make(key),
              text: `Delegated thread "${child.title}" (${child.threadId}) has had no provider activity for ${quietMinutes} minutes. Check its current state before deciding whether to wait, steer, restart, or cancel it.`,
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: "server",
              notification: {
                source: {
                  kind: "background_task",
                  quietDelegate: {
                    threadId: child.threadId,
                    runId: child.runId,
                    lastProviderActivityAt: child.lastProviderActivityAt,
                  },
                },
                outcome: "updated",
                summary: "Quiet worker",
              },
            })
            .pipe(
              Effect.tap(() => Effect.sync(() => stillDelivered.set(child.threadId, key))),
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not wake parent of quiet delegated thread", {
                  threadId: child.threadId,
                  cause,
                }),
              ),
            );
        }
        delivered = stillDelivered;
      }),
    );
  }),
);
