import { isParentThreadRelationship } from "@t3tools/client-runtime/state/thread-relationships";
import type { ThreadId } from "@t3tools/contracts";
import type { ThreadRelationshipWalkRow } from "@t3tools/client-runtime/state/thread-relationships";

const FINISHED_AGENT_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "interrupted",
  "idle",
]);

/** Stored by Show: list every finished agent, including ones auto-clear would hide. */
export const SHOW_ALL_CLEARED = "show-all";

/** Keep non-agent relationships and divide child agents into active and finished groups. */
export function groupThreadLineageRows(input: {
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly currentThreadId: ThreadId;
  readonly clearedAt: number | null;
  readonly finishedAt: (threadId: ThreadId) => number | null;
}) {
  const related: ThreadRelationshipWalkRow[] = [];
  const active: ThreadRelationshipWalkRow[] = [];
  const finished: ThreadRelationshipWalkRow[] = [];

  for (const row of input.rows) {
    if (
      row.edge.kind !== "subagent" ||
      isParentThreadRelationship(row.edge, input.currentThreadId)
    ) {
      related.push(row);
    } else if (FINISHED_AGENT_STATUSES.has(row.edge.status ?? "")) {
      finished.push(row);
    } else {
      active.push(row);
    }
  }

  const clearedAt = input.clearedAt;
  const previous =
    clearedAt === null
      ? finished
      : finished.filter(({ threadId }) => (input.finishedAt(threadId) ?? clearedAt) > clearedAt);

  return { related, active, previous, clearedCount: finished.length - previous.length };
}

/** Apply the later of a manual clear and the configured rolling auto-clear window. */
export function resolveLineageClearedAt(input: {
  readonly stored: string | undefined;
  readonly autoClearMinutes: number;
  readonly now: number;
}): number | null {
  if (input.stored === SHOW_ALL_CLEARED) return null;

  const manual = input.stored === undefined ? null : Date.parse(input.stored);
  const validManual = manual !== null && Number.isFinite(manual) ? manual : null;
  const auto = input.autoClearMinutes > 0 ? input.now - input.autoClearMinutes * 60_000 : null;
  if (validManual === null) return auto;
  return auto === null ? validManual : Math.max(validManual, auto);
}
