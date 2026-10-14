import * as DateTime from "effect/DateTime";
import type { InlineShellRunRecord, TerminalAttachStreamEvent } from "@t3tools/contracts";
import { inlineShellOutputTail } from "@t3tools/shared/inlineShell";

export const emptyInlineShellOutput = {
  output: "",
  status: "starting" as "starting" | "running" | "exited" | "closed" | "error",
  error: null as string | null,
  exitCode: null as number | null,
  endedAt: null as number | null,
  interrupted: false,
  sequence: -1,
};

/** Tail once per batch, rather than copying and parsing a 16 KiB tail per PTY chunk. */
export function applyInlineShellOutputBatch(
  current: typeof emptyInlineShellOutput,
  events: readonly TerminalAttachStreamEvent[],
  receivedAt: number,
): typeof emptyInlineShellOutput {
  let next = current;
  for (const event of events) {
    const sequence =
      event.type === "snapshot" || event.type === "restarted"
        ? event.snapshot.sequence
        : event.sequence;
    if (sequence !== undefined && sequence <= next.sequence) continue;
    if (event.type === "snapshot" || event.type === "restarted") {
      next = {
        ...emptyInlineShellOutput,
        output: event.snapshot.history,
        status: event.snapshot.status,
        sequence: event.snapshot.sequence ?? -1,
        exitCode: event.snapshot.exitCode,
        endedAt:
          event.snapshot.status === "exited" || event.snapshot.status === "error"
            ? Date.parse(event.snapshot.updatedAt)
            : null,
      };
      continue;
    }
    next = { ...next, sequence: event.sequence ?? next.sequence };
    switch (event.type) {
      case "output":
        next = { ...next, output: next.output + event.data };
        break;
      case "exited":
        next = {
          ...next,
          status: "exited",
          exitCode: event.exitCode,
          endedAt: receivedAt,
          interrupted:
            event.exitCode === 130 || (event.exitSignal !== null && event.exitSignal !== 0),
        };
        break;
      // Release follows exit; keep the exit metadata instead of replacing it.
      case "closed":
        if (next.status !== "exited" && next.status !== "error")
          next = { ...next, status: "closed", endedAt: receivedAt, interrupted: true };
        break;
      case "error":
        next = { ...next, status: "error", error: event.message, endedAt: receivedAt };
        break;
      case "cleared":
        next = { ...next, output: "" };
        break;
      case "activity":
        break;
    }
  }
  return next === current ? current : { ...next, output: inlineShellOutputTail(next.output) };
}
export function applyInlineShellOutput(
  current: typeof emptyInlineShellOutput,
  event: TerminalAttachStreamEvent,
  receivedAt = 0,
): typeof emptyInlineShellOutput {
  return applyInlineShellOutputBatch(current, [event], receivedAt);
}

/** A PTY exit always wins over a retained running row, including paged history. */
export function resolveInlineShellRun(
  record: InlineShellRunRecord | null,
  live: typeof emptyInlineShellOutput | null | undefined,
  streamError: string | null = null,
): InlineShellRunRecord | null {
  if (!record || record.status !== "running") return record;
  if (live && (live.status === "exited" || live.status === "closed" || live.status === "error"))
    return {
      ...record,
      status: live.status === "error" ? "error" : live.interrupted ? "interrupted" : "completed",
      output: live.output,
      error: live.error,
      exitCode: live.exitCode,
      completedAt: DateTime.formatIso(
        DateTime.makeUnsafe(live.endedAt ?? Date.parse(record.startedAt)),
      ),
      durationMs: Math.max(
        0,
        (live.endedAt ?? Date.parse(record.startedAt)) - Date.parse(record.startedAt),
      ),
    };
  if (streamError) return { ...record, status: "error", error: streamError };
  return record;
}

export function inlineTerminalBelongsInDrawer(
  inline: boolean | undefined,
  terminalId: string,
  attachedIds: readonly string[],
): boolean {
  return !inline || attachedIds.includes(terminalId);
}
