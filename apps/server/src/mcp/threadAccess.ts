import type { ProjectionRecordField } from "../orchestration-v2/ProjectionStore.ts";
import {
  CommandId,
  OrchestratorMcpFailure,
  type ProjectId,
  type ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as OrchestrationMcp from "./OrchestratorMcpService.ts";
import { type McpInvocationScope, McpInvocationContext } from "./McpInvocationContext.ts";

export const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });

export const readCaller = Effect.fn("mcp.readCaller")(function* () {
  const scope = yield* McpInvocationContext;
  if (!scope.capabilities.has("orchestration")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential cannot control threads.",
    });
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const caller = yield* threads.getThreadShell(scope.threadId).pipe(Effect.mapError(unavailable));
  if (caller === null || caller.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread was not found.",
    });
  }
  return { scope, threads, caller };
});

function assertLiveCaller({
  caller,
  scope,
}: {
  caller: OrchestrationV2ThreadShell;
  scope: McpInvocationScope;
}) {
  return caller.archivedAt !== null ||
    caller.activeRunId === null ||
    caller.providerInstanceId !== scope.providerInstanceId
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "The calling provider no longer owns an active thread run.",
        }),
      )
    : Effect.void;
}
export const readMutationCaller = Effect.fn("mcp.readMutationCaller")(function* () {
  const context = yield* readCaller();
  yield* assertLiveCaller(context);
  return context;
});

const notInCallingProject = (hint: string) =>
  new OrchestratorMcpFailure({
    code: "thread_not_found",
    message: `The thread was not found in the calling project.${hint}`,
  });

/**
 * Resolve the credential's project before looking up a caller-supplied thread. Reads reach
 * other projects only when `OrchestrationMcp.readsOtherProjects` allows it for the caller.
 */
export const readThread = Effect.fn("mcp.readThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const { scope, threads, caller } = yield* readCaller();
  const target = threadId ?? caller.id;
  const options = { turnItemTypes: ["user_input_request" as const] };
  const load = (projectId: ProjectId) =>
    threads
      .getProjectThreadRecords({ projectId, threadId: target }, fields, options)
      .pipe(
        Effect.mapError((error) =>
          error._tag === "ThreadManagementThreadNotFoundError"
            ? notInCallingProject("")
            : unavailable(),
        ),
      );
  const projection = yield* load(caller.projectId).pipe(
    Effect.catchIf(
      (error) => error.code === "thread_not_found",
      () =>
        Effect.gen(function* () {
          const settings = yield* Effect.serviceOption(ServerSettingsService);
          if (!(yield* OrchestrationMcp.readsOtherProjects(settings, caller))) {
            return yield* notInCallingProject(` ${OrchestrationMcp.OTHER_PROJECT_READ_HINT}`);
          }
          const shell = yield* threads.getThreadShell(target).pipe(Effect.mapError(unavailable));
          if (shell === null) return yield* notInCallingProject("");
          return yield* load(shell.projectId);
        }),
    ),
  );
  return { scope, threads, caller, projection };
});

/** Writes never follow the cross-project read allowance. */
export const readWritableThread = Effect.fn("mcp.readWritableThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const context = yield* readThread(threadId, fields);
  if (context.projection.thread.projectId !== context.caller.projectId) {
    return yield* notInCallingProject("");
  }
  yield* assertLiveCaller(context);
  yield* OrchestrationMcp.resolveRuntimeMode(
    context.caller.runtimeMode,
    context.projection.thread.runtimeMode,
  );
  yield* OrchestrationMcp.resolveInteractionMode(
    context.caller.interactionMode,
    context.projection.thread.interactionMode,
  );
  return context;
});

export const newCommandId = Effect.fn("mcp.newCommandId")(function* () {
  const crypto = yield* Crypto.Crypto;
  return CommandId.make(`mcp:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
});
