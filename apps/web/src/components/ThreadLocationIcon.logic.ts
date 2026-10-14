import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";

/**
 * Where a thread works. `kind` picks the checkout icon, and the parts feed the Projects header
 * (environment when elsewhere, then "Local" or the worktree folder, then the branch). `label` is
 * the hover text: "Local" or "Worktree <folder>", then the branch, led by the environment's name
 * when it is elsewhere. The row already names the project.
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
  const environment = remote ? input.environmentName : null;
  const worktree = input.worktreePath?.trim() ? fileBasename(input.worktreePath.trim()) : null;
  const branch = input.branch || null;
  if (!remote && !worktree && input.preparingWorktree) {
    return {
      kind: "preparing",
      environment,
      checkout: "Preparing worktree",
      branch,
      label: "Preparing worktree",
    } as const;
  }
  const label = [
    ...(environment ? [environment] : []),
    worktree ? `Worktree ${worktree}` : "Local",
    ...(branch ? [branch] : []),
  ].join(" · ");
  return worktree
    ? ({ kind: "worktree", environment, checkout: worktree, branch, label } as const)
    : ({ kind: "local", environment, checkout: "Local", branch, label } as const);
}
