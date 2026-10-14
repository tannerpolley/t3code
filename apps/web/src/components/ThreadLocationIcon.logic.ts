import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";

/**
 * Where a thread works, for its location icon's hover: the folder and branch on this machine, or
 * the environment and folder elsewhere. The project root names the main checkout.
 */
export function threadLocation(input: {
  readonly remote: boolean;
  readonly machine?: EnvironmentMachineKind;
  readonly preparingWorktree?: boolean;
  readonly environmentName: string;
  readonly worktreePath: string | null;
  readonly projectRoot?: string | null;
  readonly branch?: string | null;
}) {
  const worktree = input.worktreePath?.trim() ? fileBasename(input.worktreePath.trim()) : null;
  const folder = worktree
    ? `${worktree} (worktree)`
    : input.projectRoot
      ? fileBasename(input.projectRoot)
      : null;
  if (input.remote || input.machine === "cloud") {
    const label = folder ? `${input.environmentName} · ${folder}` : input.environmentName;
    return { kind: "environment", label } as const;
  }
  if (!worktree && input.preparingWorktree) {
    return { kind: "worktree", label: "Preparing worktree" } as const;
  }
  const label = folder
    ? input.branch
      ? `${folder} · ${input.branch}`
      : folder
    : input.environmentName;
  return { kind: worktree ? "worktree" : "checkout", label } as const;
}
