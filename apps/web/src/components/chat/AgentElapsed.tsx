import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { deriveSubagentElapsedMs } from "@t3tools/shared/orchestrationTiming";
import { useEffect, useRef } from "react";

import { formatElapsedSeconds } from "../../timestampFormat";

/**
 * Elapsed time for the current activation. Live agents self-tick via DOM
 * writes (zero React commits per tick); settled agents freeze at completedAt.
 */
export function AgentElapsed({
  agent,
}: {
  agent: Pick<RuntimeSubagent, "status" | "startedAt" | "completedAt">;
}) {
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
        textRef.current.textContent =
          elapsedMs === null ? "" : formatElapsedSeconds(elapsedMs / 1000);
      }
    };
    update();
    if (!live) return;
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt, completedAt, agent.status]);

  const elapsedMs = deriveSubagentElapsedMs(agent, 0);
  if (elapsedMs === null) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums whitespace-nowrap">
      {formatElapsedSeconds(elapsedMs / 1000)}
    </span>
  );
}
