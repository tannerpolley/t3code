import type { TerminalAttachStreamEvent } from "@t3tools/contracts";
import { inlineShellOutputTail } from "@t3tools/shared/inlineShell";

export const emptyInlineShellOutput = {
  output: "",
  status: "starting" as "starting" | "running" | "exited" | "closed" | "error",
  error: null as string | null,
  sequence: -1,
};
export function applyInlineShellOutput(
  current: typeof emptyInlineShellOutput,
  event: TerminalAttachStreamEvent,
): typeof emptyInlineShellOutput {
  if (event.type === "snapshot" || event.type === "restarted")
    return {
      output: inlineShellOutputTail(event.snapshot.history),
      status: event.snapshot.status,
      error: null,
      sequence: event.snapshot.sequence ?? -1,
    };
  if (event.sequence !== undefined && event.sequence <= current.sequence) return current;
  const next = { ...current, sequence: event.sequence ?? current.sequence };
  switch (event.type) {
    case "output":
      return { ...next, output: inlineShellOutputTail(current.output + event.data) };
    case "exited":
      return { ...next, status: "exited" };
    case "closed":
      return { ...next, status: "closed" };
    case "error":
      return { ...next, status: "error", error: event.message };
    case "cleared":
      return { ...next, output: "" };
    case "activity":
      return next;
  }
}
