import { formatElapsedSeconds } from "../../timestampFormat";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  return formatElapsedSeconds((endedAtMs - startedAtMs) / 1000);
}

export function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? formatElapsedSeconds(0);
}
