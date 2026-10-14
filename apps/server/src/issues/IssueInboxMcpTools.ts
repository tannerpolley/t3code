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
  IssueInbox.IssueInbox,
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
    "The repository orchestrator's inbox of external GitHub issue activity: new issues and comments, closes and reopens, label and milestone changes, and title renames, written by other projects or by hand. Body edits are not tracked. Available to the repository orchestrator and its delegated children. action=list returns unread events, high priority first, without bodies; action=read with ids returns those events with a snippet and link; action=mark_read marks ids read, or every unread event when ids are omitted. Triage new external issues into a milestone; nothing outside the selected milestones starts automatically.",
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
      const inbox = yield* IssueInbox.IssueInbox;
      return yield* inbox.post(yield* caller, input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_issue_inbox: McpToolAccess.actsAsCaller((input: IssueInboxToolInput) =>
    Effect.gen(function* () {
      const inbox = yield* IssueInbox.IssueInbox;
      return yield* inbox.forCaller(yield* caller, input).pipe(Effect.mapError(failure));
    }),
  ),
};
