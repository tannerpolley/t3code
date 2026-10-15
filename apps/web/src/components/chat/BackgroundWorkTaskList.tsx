import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarBackgroundWorkRows } from "../sidebar/SidebarBackgroundWorkRows";
import {
  groupBackgroundWorkTaskRows,
  type BackgroundWorkTaskRow,
} from "../sidebar/SidebarBackgroundWork.logic";
import {
  BackgroundProcessOutputView,
  BackgroundShellElapsed,
  StopBackgroundShellButton,
} from "./BackgroundProcessOutput";
import { BackgroundProcessKindIcon, backgroundProcessKindLabel } from "./BackgroundProcessKind";
import {
  backgroundTaskResourceUsageKey,
  BackgroundTaskResourceUsageLabel,
  useBackgroundTaskListVisibility,
  useBackgroundTaskResourceUsage,
} from "./BackgroundTaskUsage";

/** Mounted by the open banner or Agents panel; closing it releases output and usage queries. */
export function BackgroundWorkTaskList(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly rows: ReadonlyArray<BackgroundWorkTaskRow>;
}) {
  const { agents, backgroundTasks } = groupBackgroundWorkTaskRows(props.rows);
  const processOutput = useClientSettings((settings) => settings.backgroundProcessOutput);
  const { listRef, isVisible } = useBackgroundTaskListVisibility(backgroundTasks.length > 0);
  const resourceUsage = useBackgroundTaskResourceUsage({
    environmentId: props.environmentId,
    threadIds: backgroundTasks.map((row) => row.ownerThreadId ?? props.threadId),
    enabled: isVisible,
  });

  return (
    <div ref={listRef} className="max-h-80 space-y-2 overflow-y-auto text-xs">
      {agents.length > 0 ? <SidebarBackgroundWorkRows {...props} rows={agents} /> : null}
      <ul className="space-y-2">
        {backgroundTasks.map((row) => {
          const threadId = row.ownerThreadId ?? props.threadId;
          const usage = resourceUsage.get(backgroundTaskResourceUsageKey(threadId, row.taskId));
          const target = {
            environmentId: props.environmentId,
            threadId,
            taskId: row.taskId,
            label: row.label,
          };
          return (
            <li key={`${props.environmentId}:${threadId}:${row.taskId}`} className="space-y-1">
              <div className="flex min-w-0 items-center gap-2">
                <BackgroundProcessKindIcon
                  kind={row.kind}
                  commandKind={row.commandKind}
                  command={row.command}
                  className="size-3.5"
                />
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                    {row.label}
                  </TooltipTrigger>
                  <TooltipPopup>{row.label}</TooltipPopup>
                </Tooltip>
                <StopBackgroundShellButton {...target} />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                <span>{backgroundProcessKindLabel(row.kind, row.commandKind)}</span>
                {row.startedAt ? (
                  <BackgroundShellElapsed startedAt={row.startedAt} commandKind={row.commandKind} />
                ) : null}
                {/* No sample yet (off screen or loading) says nothing; only a sampled miss is "unavailable". */}
                {usage === undefined ? null : usage.cpuPercent == null ||
                  usage.residentBytes == null ? (
                  <span>Usage unavailable</span>
                ) : (
                  <BackgroundTaskResourceUsageLabel usage={usage} />
                )}
              </div>
              {processOutput ? <BackgroundTaskOutputDetails {...target} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BackgroundTaskOutputDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly taskId: string;
  readonly label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button
        variant="ghost"
        size="xs"
        aria-label={`${open ? "Hide" : "Show"} output for ${props.label}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide output" : "Show output"}
      </Button>
      {open ? <BackgroundProcessOutputView {...props} /> : null}
    </div>
  );
}
