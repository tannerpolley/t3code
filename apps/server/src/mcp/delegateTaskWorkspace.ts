import {
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  resolveThreadRole,
  type ThreadRole,
} from "@t3tools/contracts";
import { agentWorktreeName } from "@t3tools/shared/forkAgentWorktreeName";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

// A retry replays the accepted checkout decision from the receipt.
export const resolveDelegatedWorkspace = Effect.fn("resolveDelegatedWorkspace")(function* (input: {
  readonly task: OrchestratorMcpDelegateTaskInput;
  readonly isRetry: boolean;
  /** The parent's checkout; resolved only when the child gets a worktree. */
  readonly checkout: Effect.Effect<string, OrchestratorMcpFailure>;
  readonly gitDriver: GitVcsDriver.GitVcsDriver["Service"];
}): Effect.fn.Return<
  {
    readonly workspaceStrategy?: OrchestrationV2ThreadLaunchWorkspaceStrategy;
    readonly note?: string;
  },
  OrchestratorMcpFailure
> {
  const { task } = input;
  const role = resolveThreadRole(task.role ?? "");
  if (role === "writer" || input.isRetry) return {};
  const explicit = task.isolation ?? (task.workspace === "inherit" ? "shared" : task.workspace);
  const requested =
    explicit ?? (task.role !== "general" && role === "implementor" ? "worktree" : "shared");
  if (requested === "shared") return {};
  const base = yield* input.gitDriver
    .resolveCommit({ cwd: yield* input.checkout, revision: "HEAD" })
    .pipe(Effect.option);
  if (Option.isSome(base)) {
    // Provisioning adds `-2`, `-3` when the name is taken.
    const branch = agentWorktreeName(task.title ?? task.task);
    return {
      workspaceStrategy: {
        type: "worktree",
        baseRef: base.value.commitSha,
        branch,
        startFromOrigin: false,
      },
    };
  }
  if (explicit === "worktree") {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Unable to resolve the parent checkout commit.",
    });
  }
  return {
    note: "This thread's checkout has no git commit to branch from, so the child shares this checkout instead of getting its own worktree.",
  };
});

export const delegatedTaskRole = (
  role: OrchestratorMcpDelegateTaskInput["role"],
  worktree: boolean,
): ThreadRole =>
  role === undefined ? (worktree ? "implementor" : "designer") : resolveThreadRole(role)!;
