import {
  OrchestrationV2UserInputQuestions,
  ProviderUserInputAnswers,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { newCommandId, readCaller, unavailable } from "../../threadAccess.ts";

export const RequestUserInputTool = Tool.make("t3_request_user_input", {
  description:
    "Ask 1–3 questions and return their exact answers. Delegated child questions go to the orchestrator first. " +
    "Use an empty options array for free text; set multiSelect=true for multiple selections. " +
    "Custom text is allowed by default. This never approves a permission request.",
  parameters: Schema.Struct({ questions: OrchestrationV2UserInputQuestions }),
  success: ProviderUserInputAnswers,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const requestUserInput = McpToolAccess.actsAsCaller(
  (input: { readonly questions: OrchestrationV2UserInputQuestions }) =>
    Effect.gen(function* () {
      const { scope, caller, threads } = yield* readCaller();
      const notActive = new OrchestratorMcpFailure({
        code: "parent_not_active",
        message: "The calling provider no longer owns an active thread run.",
      });
      if (caller === undefined || scope.thread === undefined || caller.activeRunId === null)
        return yield* notActive;
      const result = yield* threads
        .requestUserInput({
          thread: { ...caller, activeRunId: caller.activeRunId },
          mcpCredentialId: scope.thread.providerSessionId,
          commandId: yield* newCommandId(),
          questions: input.questions,
        })
        .pipe(Effect.mapError(unavailable));
      switch (result.type) {
        case "answered":
          return result.answers;
        case "session_not_active":
          return yield* notActive;
        case "stream_ended":
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The user-input request ended before it was answered.",
          });
        case "dismissed":
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The user dismissed the question or the turn ended before it was answered.",
          });
      }
    }),
);
