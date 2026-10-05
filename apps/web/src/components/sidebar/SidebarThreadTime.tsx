import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import type { SidebarThreadSummary } from "../../types";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  formatStoppedThreadDuration,
  resolveSidebarThreadStatus,
  type SidebarThreadStatus,
} from "../Sidebar.logic";
import { AgentElapsed } from "../chat/AgentElapsed";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A thread's work time, with its previous age label available on hover. */
export function SidebarThreadTime(props: {
  readonly thread: SidebarThreadSummary;
  readonly status?: SidebarThreadStatus;
  readonly snoozeWakeLabel?: string | null;
}) {
  const status = props.status ?? resolveSidebarThreadStatus(props.thread);
  const startedAt =
    status === "working" || status === "waiting"
      ? resolveThreadWorkingStartedAt(props.thread)
      : null;
  const duration = startedAt ? (
    <AgentElapsed agent={{ status: "running", startedAt, completedAt: null }} />
  ) : (
    formatStoppedThreadDuration(props.thread)
  );
  if (duration === null) return null;
  const age = formatRelativeTimeLabel(
    props.thread.latestUserMessageAt ?? props.thread.updatedAt,
  ).replace(/(\d+)([mhd])\b/g, (_, count: string, unit: string) => {
    const name = unit === "m" ? "minute" : unit === "h" ? "hour" : "day";
    return `${count} ${name}${count === "1" ? "" : "s"}`;
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="pointer-events-auto tabular-nums whitespace-nowrap" />}
      >
        {duration}
      </TooltipTrigger>
      <TooltipPopup>
        <span>
          Last active {age}
          {props.snoozeWakeLabel ? (
            <>
              <br />
              {props.snoozeWakeLabel}
            </>
          ) : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
