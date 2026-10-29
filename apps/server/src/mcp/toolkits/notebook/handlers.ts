import { OrchestratorMcpFailure, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NotebookService from "../../../notebook/NotebookService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertLiveCaller, readCaller } from "../../threadAccess.ts";
import { NotebookToolkit } from "./tools.ts";

// MCP credentials authorize thread actions by live runtime mode, rather than UI session grants.
const context = Effect.fn("mcp.notebookContext")(function* (access: "read" | "write" | "execute") {
  const caller = yield* readCaller();
  yield* assertLiveCaller(caller);
  const thread = caller.caller;
  if (!thread || (caller.scope.client?.access === "read-only" && access !== "read"))
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Notebook tools require an authenticated live T3 thread with the requested permission.",
    });
  const mode = caller.limits.runtimeMode;
  const writes = caller.limits.interactionMode === "default" && mode !== "approval-required";
  const executes = writes && (mode === "auto" || mode === "full-access");
  if ((access === "write" && !writes) || (access === "execute" && !executes))
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This thread's runtime mode does not grant the requested notebook operation.",
    });
  const scopes: AuthEnvironmentScope[] = ["filesystem:read"];
  if (writes) scopes.push("filesystem:write");
  if (executes) scopes.push("terminal:operate");
  const service = yield* Effect.serviceOption(NotebookService.NotebookService);
  if (Option.isNone(service))
    return yield* new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: "Notebooks are unavailable in this environment.",
    });
  return {
    service: service.value,
    identity: { projectId: thread.projectId, threadId: thread.id },
    caller: { scopes },
  };
});
const invoke =
  <P, A>(
    access: "read" | "write" | "execute",
    operation: (
      input: P,
      ctx: Effect.Success<ReturnType<typeof context>>,
    ) => Effect.Effect<A, import("@t3tools/contracts").NotebookError>,
  ) =>
  (input: P) =>
    context(access).pipe(
      Effect.flatMap((ctx) => operation(input, ctx)),
      Effect.mapError((error) =>
        error._tag === "OrchestratorMcpFailure"
          ? error
          : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
      ),
    );

export const layer = McpToolAccess.toLayer(NotebookToolkit, {
  notebook_open: McpToolAccess.readsAsCaller(
    invoke("read", (input, c) => c.service.open({ ...input, ...c.identity }, c.caller)),
  ),
  notebook_create: McpToolAccess.actsAsCaller(
    invoke("write", (input, c) => c.service.create({ ...input, ...c.identity }, c.caller)),
  ),
  notebook_edit_cells: McpToolAccess.actsAsCaller(
    invoke("write", (input, c) => c.service.editCells({ ...input, ...c.identity }, c.caller)),
  ),
  notebook_run: McpToolAccess.actsAsCaller(
    invoke("execute", (input, c) =>
      c.service.run({ ...input, ...c.identity }, c.caller).pipe(Effect.map((runId) => ({ runId }))),
    ),
  ),
  notebook_read_outputs: McpToolAccess.readsAsCaller(
    invoke("read", (input, c) => c.service.readOutputs({ ...input, ...c.identity }, c.caller)),
  ),
  notebook_list_kernels: McpToolAccess.readsAsCaller(
    invoke("read", (input, c) => c.service.listKernels({ ...input, ...c.identity }, c.caller)),
  ),
  notebook_save: McpToolAccess.actsAsCaller(
    invoke("write", (input, c) => c.service.save({ ...input, ...c.identity }, c.caller)),
  ),
  notebook_interrupt: McpToolAccess.actsAsCaller(
    invoke("execute", (input, c) => c.service.interrupt({ ...input, ...c.identity }, c.caller)),
  ),
  notebook_restart: McpToolAccess.actsAsCaller(
    invoke("execute", (input, c) => c.service.restart({ ...input, ...c.identity }, c.caller)),
  ),
  notebook_shutdown: McpToolAccess.actsAsCaller(
    invoke("execute", (input, c) => c.service.shutdown({ ...input, ...c.identity }, c.caller)),
  ),
});
