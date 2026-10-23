import * as Option from "effect/Option";
import {
  IssueInboxToolInput,
  IssueInboxToolResult,
  IssuePostInput,
  IssuePostResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool } from "effect/ai";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as IssueInbox from "./IssueInbox.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];

export const IssuePostTool = Tool.make("t3_issue_post", {
  description:
    "Create a GitHub issue (title and body) or comment on one (issueNumber and body) in any repository. Use it instead of raw `gh` for issues in another project's repository: T3 adds a hidden source marker naming this project and thread, and labels the issue external, from:<project> and priority: high, so that repository's orchestrator is notified. Writes to this thread's own repository get neither.",
  parameters: IssuePostInput,
  success: IssuePostResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Post to a GitHub issue")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const IssueInboxTool = Tool.make("t3_issue_inbox", {
  description:
    "The repository orchestrator's inbox of issues opened and comments posted through t3_issue_post with another project's source marker. Unmarked writes and other issue changes never enter the Inbox. Available to the repository orchestrator and its delegated children. action=list returns unread events without bodies; action=read with ids returns snippets and links without acknowledging them. Review each item and revise it if needed, for example with propose_issue_change, then acknowledge it with action=mark_read. An open issue's unacknowledged opening holds it in Inbox; acknowledgment places it in Ready, or the normal section its current state gives it. Comments leave their issue in its current section. mark_read acknowledges ids, or every unread item when ids are omitted. Nothing outside the selected milestones starts automatically.",
  parameters: IssueInboxToolInput,
  success: IssueInboxToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read the issue inbox")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const failure = (cause: { readonly code: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code: cause.code === "invalid-request" ? "invalid_request" : "orchestration_error",
    message: cause.message,
  });

const caller = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "thread_credential_required",
      message: "Call this tool from an agent running inside a T3 thread.",
    });
  return scope.thread.threadId;
});

export const issueInboxHandlers = {
  t3_issue_post: McpToolAccess.actsAsCaller((input: IssuePostInput) =>
    Effect.gen(function* () {
      const available = yield* Effect.serviceOption(IssueInbox.IssueInbox);
      if (Option.isNone(available)) return yield* new OrchestratorMcpFailure({ code: "orchestration_error", message: "Issue tools are unavailable in this runtime." });
      const inbox = available.value;
      return yield* inbox.post(yield* caller, input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_issue_inbox: McpToolAccess.actsAsCaller((input: IssueInboxToolInput) =>
    Effect.gen(function* () {
      const available = yield* Effect.serviceOption(IssueInbox.IssueInbox);
      if (Option.isNone(available)) return yield* new OrchestratorMcpFailure({ code: "orchestration_error", message: "Issue tools are unavailable in this runtime." });
      const inbox = available.value;
      return yield* inbox.forCaller(yield* caller, input).pipe(Effect.mapError(failure));
    }),
  ),
};
