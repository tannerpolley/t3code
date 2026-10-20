export function sidebarCaretCount(count: number | undefined, open?: boolean) {
  if (open || count === undefined || count <= 0) return undefined;
  return count > 99 ? "99+" : String(count);
}
