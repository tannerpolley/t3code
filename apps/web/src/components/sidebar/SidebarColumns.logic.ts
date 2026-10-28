export function sidebarCaretCount(count: number | undefined, open?: boolean) {
  if (open || count === undefined || count <= 0) return undefined;
  return count > 99 ? "99+" : String(count);
}

export function sidebarBadgeKind(role: string, hasIssue: boolean, hasPr: boolean) {
  if (role === "Orchestrator") return hasPr ? "pr" : undefined;
  if (hasIssue) return "issue";
  return hasPr ? "pr" : undefined;
}
