import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";

/**
 * Where a thread works, for its location icon's hover: "Local" or "Worktree <folder>", then the
 * branch, led by the environment's name when it is elsewhere. The row already names the project.
 */
export function threadLocation(input: {
  readonly remote: boolean;
  readonly machine?: EnvironmentMachineKind;
  readonly preparingWorktree?: boolean;
  readonly environmentName: string;
  readonly worktreePath: string | null;
  readonly branch?: string | null;
}) {
  const remote = input.remote || input.machine === "cloud";
  const worktree = input.worktreePath?.trim() ? fileBasename(input.worktreePath.trim()) : null;
  if (!remote && !worktree && input.preparingWorktree) {
    return { kind: "worktree", label: "Preparing worktree" } as const;
  }
  const label = [
    ...(remote ? [input.environmentName] : []),
    worktree ? `Worktree ${worktree}` : "Local",
    ...(input.branch ? [input.branch] : []),
  ].join(" · ");
  return { kind: remote ? "environment" : worktree ? "worktree" : "checkout", label } as const;
}
