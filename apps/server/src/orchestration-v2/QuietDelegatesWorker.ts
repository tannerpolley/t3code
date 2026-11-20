import { CommandId, MessageId, type ThreadId } from "@t3tools/contracts";
import { threadActivityFromShell, threadQuietMinutes } from "@t3tools/shared/threadActivity";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Scheduler } from "../scheduling/Scheduler.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler;
    const projections = yield* ProjectionStoreV2;
    const settings = yield* ServerSettingsService;
    const threads = yield* ThreadManagementService;
    let delivered = new Map<ThreadId, string>();

    yield* scheduler.register(
      "quiet-delegates",
      Effect.gen(function* () {
        const { threads: children } = yield* projections.getShellSnapshot({
          runningDelegatesOnly: true,
        });
        const clock = {
          nowMs: yield* Clock.currentTimeMillis,
          quietMinutes: (yield* settings.getSettings).quietThreadMinutes,
        };
        const stillDelivered = new Map<ThreadId, string>();
        for (const child of children) {
          const parentThreadId = child.lineage.parentThreadId;
          const quietMinutes = threadQuietMinutes(threadActivityFromShell(child), clock);
          if (parentThreadId === null || quietMinutes === null) continue;

          const key = `quiet-delegate:${child.id}:${child.activeRunId}:${child.lastProviderActivityAt}`;
          if (delivered.get(child.id) === key) {
            stillDelivered.set(child.id, key);
            continue;
          }
          yield* threads
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(key),
              threadId: parentThreadId,
              messageId: MessageId.make(key),
              text: `Delegated thread "${child.title}" (${child.id}) has had no provider activity for ${quietMinutes} minutes. Check its current state before deciding whether to wait, steer, restart, or cancel it.`,
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: "server",
            })
            .pipe(
              Effect.tap(() => Effect.sync(() => stillDelivered.set(child.id, key))),
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not wake parent of quiet delegated thread", {
                  threadId: child.id,
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
