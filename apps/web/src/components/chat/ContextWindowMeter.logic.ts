import { COMPACTION_SUGGESTION_MIN_TOKENS } from "@t3tools/shared/claudeCompaction";

// Fallback TTL: Claude's 1h cache plus slack.
const CLAUDE_RESUME_COMPACTION_FALLBACK_MS = 70 * 60_000;

/** Offer compaction before resuming a large, idle context on supported providers. */
export function shouldOfferResumeCompaction(input: {
  readonly provider: string | null | undefined;
  readonly usedTokens: number | null | undefined;
  readonly updatedAt: string | null | undefined;
  readonly promptCacheTtlMs?: number | undefined;
  readonly now: string;
}): boolean {
  if (
    (input.provider !== "claudeAgent" && input.provider !== "codex") ||
    (input.usedTokens ?? 0) <
      (input.provider === "codex" ? 100_000 : COMPACTION_SUGGESTION_MIN_TOKENS)
  ) {
    return false;
  }

  const updatedAt = Date.parse(input.updatedAt ?? "");
  const now = Date.parse(input.now);
  return (
    Number.isFinite(updatedAt) &&
    Number.isFinite(now) &&
    now - updatedAt >= (input.promptCacheTtlMs ?? CLAUDE_RESUME_COMPACTION_FALLBACK_MS)
  );
}
