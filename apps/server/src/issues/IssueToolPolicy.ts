import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as IssueChangeService from "./IssueChangeService.ts";

/**
 * Marks an MCP request from a thread that may propose issue changes, so upstream's ungated
 * `create_issue` and `set_issue_state` are hidden from it; `propose_issue_change` is its gated path.
 */
export const makeRepositoryManagedMark = Effect.gen(function* () {
  const changes = yield* Effect.serviceOption(IssueChangeService.IssueChangeService);
  return <Scope extends McpInvocationScope>(scope: Scope): Effect.Effect<Scope> =>
    scope.thread === undefined || Option.isNone(changes)
      ? Effect.succeed(scope)
      : changes.value.isManagedCaller(scope.thread.threadId).pipe(
          // An unreadable answer hides nothing; the tools still reach the tracker's own checks.
          Effect.orElseSucceed(() => false),
          Effect.map((repositoryManaged) =>
            repositoryManaged ? { ...scope, repositoryManaged } : scope,
          ),
        );
});
