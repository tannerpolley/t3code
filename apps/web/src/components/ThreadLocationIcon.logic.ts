import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";

/**
 * Where a thread works. `kind` picks the checkout icon. `label` is the hover text: "Local" or
 * "Worktree <folder>", led by the environment's name when it is elsewhere. The row already names
 * the project.
 */
export function threadLocation(input: {
  readonly remote: boolean;
  readonly machine?: EnvironmentMachineKind;
  readonly preparingWorktree?: boolean;
  readonly environmentName: string;
  readonly worktreePath: string | null;
}) {
  const remote = input.remote || input.machine === "cloud";
  const worktree = input.worktreePath?.trim() ? fileBasename(input.worktreePath.trim()) : null;
  const kind = worktree ? "worktree" : input.preparingWorktree ? "preparing" : "local";
  const checkout = worktree
    ? `Worktree ${worktree}`
    : kind === "preparing"
      ? "Preparing worktree"
      : "Local";
  return { kind, label: remote ? `${input.environmentName} · ${checkout}` : checkout } as const;
}
