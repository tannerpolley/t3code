import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { deriveSubagentElapsedMs } from "@t3tools/shared/orchestrationTiming";
import { useEffect, useRef } from "react";

import { formatCompactElapsedSeconds, formatElapsedSeconds } from "../../timestampFormat";

export { formatCompactElapsedSeconds } from "../../timestampFormat";

/**
 * Elapsed time for the current activation. Live agents self-tick via DOM
 * writes (zero React commits per tick); settled agents freeze at completedAt.
 * `compact` drops the smaller unit for narrow rows such as Lineage.
 */
export function AgentElapsed({
  agent,
  compact = false,
}: {
  agent: Pick<RuntimeSubagent, "status" | "startedAt" | "completedAt">;
  compact?: boolean;
}) {
  const format = compact ? formatCompactElapsedSeconds : formatElapsedSeconds;
  const textRef = useRef<HTMLSpanElement>(null);
  const live = isOrchestrationV2WorkActive(agent.status);
  const startedAt = agent.startedAt;
  const completedAt = agent.completedAt;

  useEffect(() => {
    if (!startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        const elapsedMs = deriveSubagentElapsedMs(
          { status: agent.status, startedAt, completedAt },
          Date.now(),
        );
        const text = elapsedMs === null ? "" : format(elapsedMs / 1000);
        if (textRef.current.textContent !== text) textRef.current.textContent = text;
      }
    };
    update();
    if (!live) return;
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt, completedAt, agent.status, format]);

  const elapsedMs = deriveSubagentElapsedMs(agent, 0);
  if (elapsedMs === null) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums whitespace-nowrap">
      {format(elapsedMs / 1000)}
    </span>
  );
}
