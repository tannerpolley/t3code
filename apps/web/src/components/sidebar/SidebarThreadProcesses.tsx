import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import type { ThreadProcessGroup } from "@t3tools/contracts";
import { shellProgramName } from "@t3tools/shared/shellCommand";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type CSSProperties, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import type { SidebarThreadSummary } from "../../types";
import { useBackgroundTaskListVisibility } from "../chat/BackgroundTaskUsage";
import { PROJECTS_WORK_ROW_HEIGHT, SidebarThreadColumns } from "./SidebarColumns";
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
 * list controlled by the thread caret. Commands and processes are experimental ("Show running
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
  const work = foldThreadWork(rows, commandRows);
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
    /** The agents and process entries under the thread, folded ones included. */
    workCount: work.agents.length + processCount,
    processRows: {
      expansionKey: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      groups: processGroups,
      hiddenGroupCount: hiddenProcessGroups,
      /** Number of visible or folded programs. */
      count: processCount,
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

export function SidebarProcessGroupRows(props: ProcessRowsProps) {
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
