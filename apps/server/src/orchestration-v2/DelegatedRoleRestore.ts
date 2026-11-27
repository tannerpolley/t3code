import { OrchestratorMcpTaskRole, ThreadId } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";

const decodeRoles = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(ThreadId, OrchestratorMcpTaskRole)),
);

export const restoreFromFile = Effect.fn("DelegatedRoleRestore.restoreFromFile")(function* (
  path: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const roles = yield* decodeRoles(yield* fileSystem.readFileString(path));
  const counts = { restored: 0, alreadyPresent: 0, missing: 0, notDelegated: 0, failed: 0 };
  for (const [id, role] of Object.entries(roles)) {
    const threadId = ThreadId.make(id);
    const outcome = yield* orchestrator
      .restoreDelegatedRole(threadId, role)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("delegated role restore failed for thread", { threadId, cause }).pipe(
            Effect.as("failed" as const),
          ),
        ),
      );
    counts[outcome] += 1;
  }
  return counts;
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const path = yield* Config.String("T3CODE_RESTORE_DELEGATED_ROLES_FILE").pipe(Config.option);
    if (Option.isNone(path)) return;
    yield* forkParked(
      restoreFromFile(path.value).pipe(
        Effect.tap((counts) => Effect.logInfo("delegated role restore finished", counts)),
        Effect.catch((cause) =>
          Effect.logError("could not read delegated role restore file", { cause }),
        ),
      ),
    );
  }),
);
