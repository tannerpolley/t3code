import * as Option from "effect/Option";
import {
  IssueLinkInput,
  IssueLinkResult,
  IssueLinkError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool } from "effect/ai";
import * as Effect from "effect/Effect";
import * as IssueLinks from "./IssueLinks.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as Schema from "effect/Schema";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];
export const LinkIssueTool = Tool.make("link_issue", {
  description:
    "Register an issue this thread works on in the live roadmap. Works for ordinary threads and delegated children, without a repository orchestrator. Pass an issue URL, or repository and number (host defaults to github.com). Omit threadId for this thread. Repeated links succeed with changed=false.",
  parameters: IssueLinkInput,
  success: IssueLinkResult,
  failure: Schema.Union([IssueLinkError, OrchestratorMcpFailure]),
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
export const UnlinkIssueTool = Tool.make("unlink_issue", {
  description:
    "Remove an ordinary issue association from this thread, for example if linked by mistake. Uses the same target as link_issue. Does not alter repository-managed work or PR references.",
  parameters: IssueLinkInput,
  success: IssueLinkResult,
  failure: Schema.Union([IssueLinkError, OrchestratorMcpFailure]),
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const issueLinkHandlers = {
  link_issue: McpToolAccess.writesThreads(
    (input: IssueLinkInput) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const available = yield* Effect.serviceOption(IssueLinks.IssueLinks);
      if (Option.isNone(available)) return yield* new OrchestratorMcpFailure({ code: "orchestration_error", message: "Issue tools are unavailable in this runtime." });
      const links = available.value;
        return yield* links.link(input, scope.thread?.threadId);
      }),
  ),
  unlink_issue: McpToolAccess.writesThreads(
    (input: IssueLinkInput) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const available = yield* Effect.serviceOption(IssueLinks.IssueLinks);
      if (Option.isNone(available)) return yield* new OrchestratorMcpFailure({ code: "orchestration_error", message: "Issue tools are unavailable in this runtime." });
      const links = available.value;
        return yield* links.link(input, scope.thread?.threadId, true);
      }),
  ),
};
