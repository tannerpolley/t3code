/** Keep the usage column within five characters, including rounded unit boundaries. */
export function formatSidebarTokens(tokens: number | undefined): string {
  if (tokens === undefined) return "—";
  if (tokens < 1_000) return String(tokens);
  if (tokens < 999_500) return `${Math.round(tokens / 1_000)}k`;
  return `${Number((tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0))}m`;
}
