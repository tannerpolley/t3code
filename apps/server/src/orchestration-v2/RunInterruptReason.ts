export const USER_STOP_REASON = "Stopped by user";
export const FORCE_STOP_REASON = "Force stopped by user";

const AGENT_STOP_REASON = "Stopped by an agent";

export function agentStopReason(reason: string | undefined): string {
  return reason === undefined ? AGENT_STOP_REASON : `${AGENT_STOP_REASON}: ${reason}`;
}

export function isExplicitStopReason(reason: string | null | undefined): boolean {
  return (
    reason === USER_STOP_REASON ||
    reason === FORCE_STOP_REASON ||
    reason === AGENT_STOP_REASON ||
    reason?.startsWith(`${AGENT_STOP_REASON}: `) === true
  );
}
