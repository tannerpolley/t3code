import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionMaintenanceV2 } from "./ProjectionMaintenance.ts";

const COMPACTION_INTERVAL = "1 hour";

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenanceV2;
    const compact = maintenance.compactEventStore.pipe(
      Effect.tap((summary) => Effect.logInfo("orchestration-v2.event-store.compacted", summary)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("orchestration-v2.event-store.compaction-failed", { cause }),
      ),
    );

    // One scoped loop starts at boot, sleeps after each pass, and cannot overlap itself.
    yield* Effect.forever(compact.pipe(Effect.andThen(Effect.sleep(COMPACTION_INTERVAL)))).pipe(
      Effect.forkScoped,
    );
  }),
);
