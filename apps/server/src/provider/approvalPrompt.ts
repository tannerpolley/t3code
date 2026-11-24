export function combineApprovalPrompt(
  descriptions: ReadonlyArray<string | null | undefined>,
  operation?: string | null,
): string | undefined {
  const seen = new Set<string>();
  const parts: Array<string> = [];
  for (const description of descriptions) {
    const trimmed = description?.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      parts.push(trimmed);
    }
  }

  if (operation !== undefined && operation !== null) {
    const operationKey = operation.trim();
    if (operationKey && !seen.has(operationKey)) {
      parts.push(operation);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
