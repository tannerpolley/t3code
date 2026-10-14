import type { EnvironmentMachineKind } from "@t3tools/contracts";

export function threadLocation(input: {
  readonly remote: boolean;
  readonly machine?: EnvironmentMachineKind;
  readonly preparingWorktree?: boolean;
  readonly environmentName: string;
  readonly worktreePath: string | null;
}) {
  if (input.remote || input.machine === "cloud")
    return { kind: "environment", label: input.environmentName } as const;
  const path = input.worktreePath?.trim().replace(/[\\/]+$/, "");
  if (path) return { kind: "worktree", label: `Worktree: ${path.split(/[\\/]/).at(-1)}` } as const;
  if (input.preparingWorktree) return { kind: "worktree", label: "Preparing worktree" } as const;
  return { kind: "checkout", label: input.environmentName } as const;
}
