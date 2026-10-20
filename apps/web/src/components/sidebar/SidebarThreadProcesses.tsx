import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import type { ThreadProcessGroup } from "@t3tools/contracts";
import { shellProgramName } from "@t3tools/shared/shellCommand";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChevronRightIcon } from "lucide-react";
import { type CSSProperties, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import type { SidebarThreadSummary } from "../../types";
import { useBackgroundTaskListVisibility } from "../chat/BackgroundTaskUsage";
import { PROJECTS_WORK_ROW_HEIGHT, SidebarCaretSlot, SidebarThreadColumns } from "./SidebarColumns";
import type { BackgroundWorkTaskRow } from "./SidebarBackgroundWork.logic";
import {
  foldThreadWork,
  hasKnownSidebarWork,
  visibleProcessGroups,
  withRunningProcessWork,
  threadProcessesHaveWork,
} from "./SidebarThreadProcesses.logic";
import type { SidebarThreadStatus } from "../Sidebar.logic";
import { SidebarThreadProcessesGroup } from "./SidebarThreadProcessesGroup";

const NO_COMMAND_ROWS: ReadonlyArray<BackgroundWorkTaskRow> = [];
const NO_GROUPS: ReadonlyArray<ThreadProcessGroup> = [];

/**
 * A thread's work rows, with its tasks, running commands and spawned processes folded into one
 * Processes row that starts collapsed. Commands and processes are experimental ("Show running
 * commands and processes"): they poll with task usage's cadence, only while the setting is on,
 * work is known from the thread state or the last sample still found some, and the element given
 * `watchRow` as its ref (the thread's row) is on screen.
 */
export function useSidebarThreadProcesses(
  thread: SidebarThreadSummary,
  status: SidebarThreadStatus,
  rows: ReadonlyArray<BackgroundWorkTaskRow>,
) {
  const hasKnownWork = hasKnownSidebarWork(thread, status, rows);
  // A command can outlive its turn without a roster entry; once a sample sees running work, keep
  // sampling until one comes back empty, so the row doesn't drop it when the thread settles.
  const [sampledWork, setSampledWork] = useState(false);
  const wanted =
    useClientSettings((settings) => settings.runningCommandsAndProcesses) &&
    (hasKnownWork || sampledWork);
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
  if (data !== undefined && threadProcessesHaveWork(data) !== sampledWork) {
    setSampledWork(!sampledWork);
  }
  // Open state lives in the sidebar's keyed expand record, like Lineage's details.
  const openKey = `processes:${scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}`;
  const open = useUiStateStore((state) => state.lineageDetailsExpandedById[openKey] === true);
  const setExpanded = useUiStateStore((state) => state.setLineageDetailsExpanded);
  const commandRows =
    data?.commands.map((command): BackgroundWorkTaskRow => ({
      taskId: command.taskId,
      label: shellProgramName(command.command) ?? commandDisplayText(command.command),
      kind: "command",
      startedAt: command.startedAt,
      commandKind: command.commandKind,
      command: command.command,
      followable: command.followable,
      ownerThreadId: thread.id,
    })) ?? NO_COMMAND_ROWS;
  const work = foldThreadWork(rows, commandRows, open);
  const { groups: processGroups, hiddenCount: hiddenProcessGroups } = visibleProcessGroups(
    work.work,
    data?.processGroups ?? NO_GROUPS,
  );
  const processCount = work.work.length + processGroups.length + hiddenProcessGroups;
  return {
    status: withRunningProcessWork(status, data, hasKnownWork),
    // Only rows that would poll watch their visibility.
    watchRow: wanted ? listRef : undefined,
    workRows: work.rows,
    /** The agents and Processes entries under the thread, folded ones included. */
    workCount: work.agents.length + processCount,
    processRows: {
      expansionKey: openKey,
      groups: processGroups,
      hiddenGroupCount: hiddenProcessGroups,
      /** Rows the Processes row opens into; none means no Processes row. */
      count: processCount,
      open,
      onToggle: () => setExpanded([openKey], !open),
    },
  };
}

export type SidebarProcessRows = ReturnType<typeof useSidebarThreadProcesses>["processRows"];

type ProcessRowsProps = SidebarProcessRows & {
  /** The Projects tree's aligned columns; otherwise the compact list. */
  readonly columns: boolean;
  /** Nesting level below the top-level thread, for the columns' tint. */
  readonly depth?: number | undefined;
};

function processRowLayout(props: ProcessRowsProps) {
  return {
    className: cn(
      "fork-sidebar-process flex min-w-0 items-center gap-2 text-muted-foreground",
      PROJECTS_WORK_ROW_HEIGHT,
      props.columns ? "rounded-md px-2 sidebar-thread-tint" : "px-1.5",
    ),
    style: props.columns
      ? ({ "--sidebar-thread-depth": props.depth ?? 1 } as CSSProperties)
      : undefined,
  };
}

/**
 * The Processes row a thread's tasks, commands and processes fold into, first in its work list.
 * Its caret uses the same leftmost column as the thread rows.
 */
export function SidebarProcessSummaryRow(props: ProcessRowsProps) {
  if (props.count === 0) return null;
  const { className, style } = processRowLayout(props);
  const name = <span className="fork-sidebar-title block truncate">Processes</span>;
  const count = props.open ? undefined : props.count;
  return (
    <li style={style}>
      <button
        type="button"
        aria-expanded={props.open}
        className={cn(className, "w-full cursor-pointer text-left hover:bg-accent")}
        onClick={props.onToggle}
      >
        {props.columns ? (
          <SidebarThreadColumns
            caret={<SidebarCaretSlot open={props.open} />}
            name={name}
            wideName
            count={count}
          />
        ) : (
          <>
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3.5 shrink-0 transition-transform", props.open && "rotate-90")}
            />
            {name}
            <span className="ms-auto text-2xs tabular-nums">{count}</span>
          </>
        )}
      </button>
    </li>
  );
}

/**
 * List items for an open Processes row: one row per program of spawned process that no command
 * already names, then how many groups are not shown. They follow the thread's tasks and commands,
 * ahead of its agents.
 */
export function SidebarProcessGroupRows(props: ProcessRowsProps) {
  if (!props.open) return null;
  const { className, style } = processRowLayout(props);
  return (
    <>
      {props.groups.map((group) => (
        <SidebarThreadProcessesGroup
          key={group.label}
          group={group}
          expansionKey={props.expansionKey}
          columns={props.columns}
          className={className}
          style={style}
        />
      ))}
      {props.hiddenGroupCount > 0 ? (
        <li style={style}>
          <div className={className}>
            {props.columns ? (
              <SidebarThreadColumns
                name={<span className="fork-sidebar-title">+{props.hiddenGroupCount} more</span>}
                wideName
              />
            ) : (
              <span className="fork-sidebar-title">+{props.hiddenGroupCount} more</span>
            )}
          </div>
        </li>
      ) : null}
    </>
  );
}
