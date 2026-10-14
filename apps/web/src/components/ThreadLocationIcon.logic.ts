export function threadLocation(input: {
  readonly remote: boolean;
  readonly environmentName: string;
  readonly worktreePath: string | null;
}) {
  if (input.remote) return { kind: "environment", label: input.environmentName } as const;
  const path = input.worktreePath?.trim().replace(/[\\/]+$/, "");
  if (path) return { kind: "worktree", label: `Worktree: ${path.split(/[\\/]/).at(-1)}` } as const;
  return { kind: "checkout", label: input.environmentName } as const;
}
