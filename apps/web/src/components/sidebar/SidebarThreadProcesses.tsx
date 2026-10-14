import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import type { ThreadProcessGroup } from "@t3tools/contracts";
import { CpuIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import type { SidebarThreadSummary } from "../../types";
import {
  BackgroundTaskResourceUsageLabel,
  useBackgroundTaskListVisibility,
} from "../chat/BackgroundTaskUsage";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PROJECTS_WORK_ROW_HEIGHT, SidebarThreadColumns } from "./SidebarColumns";
import type { BackgroundWorkTaskRow } from "./SidebarBackgroundWork.logic";

const NO_COMMAND_ROWS: ReadonlyArray<BackgroundWorkTaskRow> = [];
const NO_GROUPS: ReadonlyArray<ThreadProcessGroup> = [];

/**
 * Experimental ("Show running commands and processes"): the commands a thread's agent is running
 * now, as background-work rows, and the processes its commands and tasks spawned. Polls with task
 * usage's cadence, only while the setting is on, `working` says the thread has work running, and
 * the element given `watchRow` as its ref (the thread's row) is on screen.
 */
export function useSidebarThreadProcesses(thread: SidebarThreadSummary, working: boolean) {
  const wanted = useClientSettings((settings) => settings.runningCommandsAndProcesses) && working;
  const { listRef, isVisible: enabled } = useBackgroundTaskListVisibility(wanted);
  const query = useEnvironmentQuery(
    enabled
      ? serverEnvironment.threadProcesses({
          environmentId: thread.environmentId,
          input: { threadId: thread.id },
        })
      : null,
  );
  const data = enabled ? query.data : undefined;
  return {
    // Only rows that would poll watch their visibility.
    watchRow: wanted ? listRef : undefined,
    commandRows:
      data?.commands.map((command): BackgroundWorkTaskRow => ({
        taskId: command.taskId,
        label: commandDisplayText(command.command),
        kind: "command",
        startedAt: command.startedAt,
        commandKind: command.commandKind,
        command: command.command,
        followable: command.followable,
        ownerThreadId: thread.id,
      })) ?? NO_COMMAND_ROWS,
    processGroups: data?.processGroups ?? NO_GROUPS,
    hiddenProcessGroups: data?.hiddenProcessGroupCount ?? 0,
  };
}

/**
 * List items for a work list's `afterTasks`: one row per group of same-shaped spawned processes,
 * then how many groups are not shown.
 */
export function SidebarProcessGroupRows(props: {
  readonly groups: ReadonlyArray<ThreadProcessGroup>;
  readonly hiddenGroupCount: number;
  /** The Projects tree's aligned columns; otherwise the compact list. */
  readonly columns: boolean;
  /** Nesting level below the top-level thread, for the columns' tint. */
  readonly depth?: number | undefined;
}) {
  if (props.groups.length === 0) return null;
  const rowClass = cn(
    "flex min-w-0 items-center gap-2 text-muted-foreground",
    PROJECTS_WORK_ROW_HEIGHT,
    props.columns ? "rounded-md px-2 sidebar-thread-tint" : "px-1.5",
  );
  const depth = props.columns
    ? ({ "--sidebar-thread-depth": props.depth ?? 1 } as CSSProperties)
    : undefined;
  return (
    <>
      {props.groups.map((group) => {
        const name = (
          <span className="flex min-w-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                {group.label}
              </TooltipTrigger>
              <TooltipPopup side="right">
                {group.count > 1 ? `${group.count} processes: ${group.label}` : group.label}
              </TooltipPopup>
            </Tooltip>
            {group.count > 1 ? <span className="shrink-0">×{group.count}</span> : null}
            <BackgroundTaskResourceUsageLabel usage={group} />
          </span>
        );
        const icon = <CpuIcon aria-hidden className={props.columns ? "size-4" : "size-3.5"} />;
        return (
          <li key={`process:${group.label}`} style={depth}>
            <div className={rowClass}>
              {props.columns ? (
                <SidebarThreadColumns provider={icon} name={name} />
              ) : (
                <>
                  {icon}
                  {name}
                </>
              )}
            </div>
          </li>
        );
      })}
      {props.hiddenGroupCount > 0 ? (
        <li style={depth}>
          <div className={rowClass}>
            {props.columns ? (
              <SidebarThreadColumns name={`+${props.hiddenGroupCount} more`} />
            ) : (
              `+${props.hiddenGroupCount} more`
            )}
          </div>
        </li>
      ) : null}
    </>
  );
}
