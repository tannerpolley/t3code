import {
  OwnerDecision,
  OwnerDecisionRequest,
  OwnerDecisionWithdrawInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool } from "effect/ai";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OwnerDecisions from "./OwnerDecisions.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
];
export const RequestOwnerDecisionTool = Tool.make("request_owner_decision", {
  description:
    "Request an owner decision on a GitHub issue or pull request (pass its number; they share one sequence), only while Don't ask mode is on (your question tool returns an away note instead of the user's answer). While Ask mode is on, ask the user with your question tool; this tool refuses. Supply 2–4 options with stable ids, labels and consequences, a recommendation with its reason and evidence link, and a stable clientRequestId for retries. The server records your thread and project and publishes an audit comment. Only T3's signed-in owner interface can choose; Ask mode never answers these requests. An answer does not approve an issue-change proposal.",
  parameters: OwnerDecisionRequest,
  success: OwnerDecision,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Request an owner decision")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);
export const ListOwnerDecisionsTool = Tool.make("list_owner_decisions", {
  description:
    "List this calling thread's owner decision requests, including publication, choice and undelivered notification status.",
  parameters: Tool.EmptyParams,
  success: Schema.Array(OwnerDecision),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List owner decisions")
  .annotate(Tool.Readonly, true);
export const WithdrawOwnerDecisionTool = Tool.make("withdraw_owner_decision", {
  description:
    "Withdraw this calling thread's own unanswered owner decision, with a reason. Options are immutable: withdraw and make a new request to change them. Answered decisions cannot be withdrawn.",
  parameters: OwnerDecisionWithdrawInput,
  success: OwnerDecision,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Withdraw an owner decision")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
const caller = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "thread_credential_required",
      message: "Call this tool from an agent running inside a T3 thread.",
    });
  return scope.thread.threadId;
});
const failure = (cause: { readonly code: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code: cause.code === "invalid-request" ? "invalid_request" : "orchestration_error",
    message: cause.message,
  });
export const ownerDecisionHandlers = {
  request_owner_decision: McpToolAccess.actsAsCaller((input: OwnerDecisionRequest) =>
    Effect.gen(function* () {
      const optionalService = yield* Effect.serviceOption(OwnerDecisions.OwnerDecisions);
      if (Option.isNone(optionalService))
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Owner decisions are unavailable in this environment.",
        });
      const service = optionalService.value;
      return yield* service.request(yield* caller, input).pipe(Effect.mapError(failure));
    }),
  ),
  list_owner_decisions: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const optionalService = yield* Effect.serviceOption(OwnerDecisions.OwnerDecisions);
      if (Option.isNone(optionalService))
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Owner decisions are unavailable in this environment.",
        });
      const service = optionalService.value;
      return yield* service.listForCaller(yield* caller).pipe(Effect.mapError(failure));
    }),
  ),
  withdraw_owner_decision: McpToolAccess.actsAsCaller((input: OwnerDecisionWithdrawInput) =>
    Effect.gen(function* () {
      const optionalService = yield* Effect.serviceOption(OwnerDecisions.OwnerDecisions);
      if (Option.isNone(optionalService))
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Owner decisions are unavailable in this environment.",
        });
      const service = optionalService.value;
      return yield* service.withdraw(yield* caller, input).pipe(Effect.mapError(failure));
    }),
  ),
};
