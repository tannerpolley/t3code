import {
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  resolveThreadRole,
  type ThreadRole,
} from "@t3tools/contracts";
import { agentWorktreeName } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/**
 * Where a delegated child works. Explicit isolation wins, then the deprecated
 * workspace alias (inherit means shared), then the role default: Implementors
 * get their own worktree, other roles share this thread's checkout. A worktree
 * child gets a branch named for its task, cut from this checkout's current
 * local commit. Outside git, a default falls back to this checkout with a note;
 * an explicit request fails. A retry replays the accepted command, whose
 * decision stands.
 */
export const resolveDelegatedWorkspace = (input: {
  readonly task: OrchestratorMcpDelegateTaskInput;
  readonly isRetry: boolean;
  /** The parent's checkout; resolved only when the child gets a worktree. */
  readonly checkout: Effect.Effect<string, OrchestratorMcpFailure>;
  readonly gitDriver: GitVcsDriver.GitVcsDriver["Service"];
}): Effect.Effect<
  {
    readonly workspaceStrategy?: OrchestrationV2ThreadLaunchWorkspaceStrategy;
    readonly note?: string;
  },
  OrchestratorMcpFailure
> =>
  Effect.gen(function* () {
    const { task } = input;
    const explicit = task.isolation ?? (task.workspace === "inherit" ? "shared" : task.workspace);
    const requested =
      explicit ??
      (task.role !== "general" && resolveThreadRole(task.role ?? "") === "implementor"
        ? "worktree"
        : "shared");
    if (requested === "shared" || input.isRetry) return {};
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

/**
 * The child's thread role. A child without one, or with legacy general, edits
 * code when it gets its own worktree, so it is an Implementor; otherwise it is
 * an Investigator.
 */
export const delegatedTaskRole = (
  role: OrchestratorMcpDelegateTaskInput["role"],
  worktree: boolean,
): ThreadRole =>
  role === undefined || role === "general"
    ? worktree
      ? "implementor"
      : "investigator"
    : resolveThreadRole(role)!;
