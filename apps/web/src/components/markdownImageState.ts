/** Signing and browser failures share one visible, path-bearing fallback. */
export function markdownImageUnavailableLabel(input: {
  readonly path: string;
  readonly sourceFailed?: boolean | undefined;
  readonly loadFailed?: boolean | undefined;
  readonly reason?: string | undefined;
  readonly kind?: "image" | "video" | undefined;
}): string | null {
  if (!input.sourceFailed && !input.loadFailed) return null;
  const kind = input.kind === "video" ? "Video" : "Image";
  const reason = input.reason?.trim();
  return `${kind} not available: ${input.path}${reason ? ` (${reason})` : ""}`;
}
