import {
  sidebarSubagentRowKey,
  type SidebarFamilySeparator,
} from "./SidebarFamilySeparators.logic";
import { useEnvironmentProviders } from "../../state/environments";
import {
  formatModelSelectionEffort,
  shortModelSelectionEffort,
} from "@t3tools/client-runtime/state/thread-execution";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isProviderNativeSubagentThread,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CornerDownRightIcon } from "lucide-react";
import {
  Fragment,
  useRef,
  type ComponentProps,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { useClientSettings } from "../../hooks/useSettings";
import {
  BackgroundProcessOutputButton,
  BackgroundShellElapsed,
  StopBackgroundShellButton,
  STOP_SHELL_ON_ROW_HOVER_CLASS,
} from "../chat/BackgroundProcessOutput";
import {
  BackgroundProcessKindIcon,
  backgroundProcessKindLabel,
} from "../chat/BackgroundProcessKind";
import { useThreadShell } from "../../state/entities";
import type { SidebarThreadSummary } from "../../types";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import {
  SidebarCaretToggle,
  SidebarThreadColumns,
  PROJECTS_WORK_ROW_HEIGHT,
} from "./SidebarColumns";
import { ThreadStatusMark } from "../ThreadStatusMark";
import { AgentElapsed } from "../chat/AgentElapsed";
import {
  SidebarProjectThreadName,
  SidebarProjectThreadTooltip,
} from "./SidebarProjectThreadTooltip";
import { SidebarThreadTime } from "./SidebarThreadTime";
import { useThreadContextPointerDrag } from "../chat/threadContextDrag";
import {
  afterTasksIndex,
  childWorktreeLabel,
  resolveSidebarThreadModelLabel,
  sidebarThreadTitle,
  type BackgroundWorkTaskRow,
} from "./SidebarBackgroundWork.logic";
import { ThreadRelationshipIcon } from "../chat/ThreadRelationshipIcon";
import { ThreadLocationIcon } from "../ThreadLocationIcon";
import { workRowProgram } from "./SidebarThreadProcesses.logic";
import { ThreadRoleIcon, threadLocationCell } from "../ThreadRoleIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { SidebarThreadStatus } from "../Sidebar.logic";

/** A row's label; a command's full command line shows on hover. */
function RowLabel(props: {
  readonly className: string;
  readonly command: string | undefined;
  readonly children: ReactNode;
}) {
  if (!props.command) return <span className={props.className}>{props.children}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={props.className} />}>
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="right">{props.command}</TooltipPopup>
    </Tooltip>
  );
}

export type NestedWork = {
  readonly status?: SidebarThreadStatus;
  readonly toggle: {
    readonly count: number;
    readonly open: boolean;
    readonly onToggle: () => void;
  } | null;
  readonly children: ReactNode;
  readonly ref?: ((element: Element | null) => void) | undefined;
};

export type SidebarBackgroundWorkRowsProps = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly rows: ReadonlyArray<BackgroundWorkTaskRow>;
  readonly compact?: boolean;
  readonly columns?: boolean;
  readonly familySeparators?: ReadonlyMap<string, SidebarFamilySeparator> | undefined;
  /** Threads that carry their location's icon; without it every subagent row shows its own. */
  readonly locationLeadKeys?: ReadonlySet<string> | undefined;
  /** Nesting level of these rows below their top-level thread, which sets their tint's shade. */
  readonly depth?: number;
  /**
   * Draws a subagent row through `render` with that agent's own work (its toggle, nested rows and
   * the list item ref its queries watch), so a component here can hold the work's state.
   */
  readonly renderAgent?: (
    row: BackgroundWorkTaskRow,
    render: (nested: NestedWork | null) => ReactNode,
  ) => ReactNode;
  /** The list item the thread's tasks and commands fold into, first in the list. */
  readonly summary?: ReactNode;
  /** List items placed after the thread's own tasks and commands, ahead of its agents. */
  readonly afterTasks?: ReactNode;
  readonly onChildClick?: (event: ReactMouseEvent, thread: SidebarThreadSummary) => void;
  readonly onChildContextMenu?: (
    thread: SidebarThreadSummary,
    position: { readonly x: number; readonly y: number },
  ) => void;
};

/** Subagent and background task rows in the sidebar's shared thread columns. */
export function SidebarBackgroundWorkRows(props: SidebarBackgroundWorkRowsProps) {
  const navigate = useNavigate();
  const providers = useEnvironmentProviders().get(props.environmentId);
  const owner = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const ownerProvider = providers?.find((entry) => entry.instanceId === owner?.providerInstanceId);
  // One drag at a time, so the list shares one drag and notes which subagent row started it.
  const draggedChild = useRef<{ readonly threadId: ThreadId; readonly title: string } | null>(null);
  const childDrag = useThreadContextPointerDrag(() => ({
    threads: draggedChild.current
      ? [scopeThreadRef(props.environmentId, draggedChild.current.threadId)]
      : [],
    title: draggedChild.current?.title ?? "Thread",
  }));
  // Rows keep describeSidebarBackgroundWork's order: the thread's own tasks, then its agents.
  // `afterTasks` goes between them.
  const rows = props.rows;
  const afterTasksAt = afterTasksIndex(rows);
  const familyStyle = useClientSettings((settings) => settings.sidebarFamilyStyle);
  const locationStyle = useClientSettings((settings) => settings.sidebarLocationIconStyle);
  const processOutput = useClientSettings((settings) => settings.backgroundProcessOutput);
  const shortModelNames = useClientSettings((settings) => settings.shortModelNames);
  // Column rows take their group's tint, at their depth.
  const rowClass = cn(
    "fork-sidebar-agent",
    props.columns ? "rounded-md px-2 sidebar-thread-tint" : "px-1.5",
  );

  return (
    <ul
      className={cn(
        props.columns
          ? "text-2xs"
          : props.compact
            ? "max-h-40 overflow-y-auto text-2xs"
            : "max-h-48 space-y-0.5 overflow-y-auto pb-1 text-xs",
      )}
    >
      {props.summary}
      {rows.flatMap((row, index) => {
        const kindLabel =
          row.kind === "subagent"
            ? row.child
              ? isProviderNativeSubagentThread(row.child.source)
                ? "Native subagent · Runs on its own"
                : "Child thread · Accepts messages"
              : "Subagent"
            : backgroundProcessKindLabel(row.kind, row.commandKind);
        const taskThreadId =
          row.kind === "subagent" ? props.threadId : (row.ownerThreadId ?? props.threadId);
        const childThreadId = row.kind === "subagent" ? row.childThreadId : null;
        const provider =
          row.kind === "subagent" && row.child
            ? providers?.find((entry) => entry.instanceId === row.child?.providerInstanceId)
            : ownerProvider;
        const icon =
          row.kind === "subagent" ? (
            <ThreadRelationshipIcon
              driver={provider?.driver}
              provider={provider}
              fallbackIcon={CornerDownRightIcon}
            />
          ) : (
            <BackgroundProcessKindIcon
              kind={row.kind}
              commandKind={row.commandKind}
              command={row.command}
              className={props.columns ? "size-4" : "size-3.5"}
            />
          );
        const renderRow = (nested: NestedWork | null) => {
          const status = nested?.status ?? row.status ?? "working";
          const toggle = nested?.toggle ?? null;
          const worktree =
            row.kind === "subagent" && row.child ? childWorktreeLabel(row.child, owner) : null;
          // In Projects only each location's lead carries the icon; other cells stay empty.
          const locationIcon =
            row.kind === "subagent" && row.child
              ? threadLocationCell(
                  row.child.source,
                  props.locationLeadKeys?.has(
                    scopedThreadKey(scopeThreadRef(props.environmentId, row.child.id)),
                  ) !== false ? (
                    <ThreadLocationIcon
                      thread={row.child}
                      tooltip={!props.columns}
                      worktreeStyle={props.columns ? locationStyle : undefined}
                    />
                  ) : null,
                )
              : null;
          const roleIcon =
            row.kind === "subagent" && row.child ? (
              <ThreadRoleIcon thread={row.child.source} nativeMark={false} />
            ) : null;
          // Commands and tasks go by their program only; the full command is on hover and in the popup.
          const name =
            row.kind === "subagent"
              ? row.label
              : (workRowProgram(row) ?? backgroundProcessKindLabel(row.kind, row.commandKind));
          const sameProgram = row.kind === "subagent" ? undefined : row.sameProgram;
          const nameDetail =
            row.kind === "subagent"
              ? undefined
              : `${sameProgram ? `${sameProgram} running, such as ` : ""}${row.command ?? row.label}`;
          const modelLabel =
            row.kind === "subagent" && row.child
              ? resolveSidebarThreadModelLabel(row.child, provider, shortModelNames)
              : null;
          const time =
            row.kind === "subagent" && row.child ? (
              <SidebarThreadTime thread={row.child} status={status} />
            ) : row.startedAt ? (
              row.kind === "subagent" ? (
                <AgentElapsed
                  agent={{ status: "running", startedAt: row.startedAt, completedAt: null }}
                />
              ) : (
                <BackgroundShellElapsed startedAt={row.startedAt} commandKind={row.commandKind} />
              )
            ) : null;
          const content = props.columns ? (
            <SidebarThreadColumns
              location={locationIcon}
              role={roleIcon}
              provider={icon}
              model={
                row.kind === "subagent" && row.child
                  ? resolveSidebarThreadModelLabel(row.child, provider, true, false)
                  : undefined
              }
              effort={
                row.kind === "subagent" && row.child
                  ? shortModelSelectionEffort(
                      formatModelSelectionEffort(row.child.modelSelection, provider?.models),
                    )
                  : undefined
              }
              name={
                <span className="flex min-w-0 items-center gap-2">
                  <RowLabel
                    className="fork-sidebar-title min-w-0 flex-1 truncate"
                    command={nameDetail}
                  >
                    {row.kind === "subagent" && row.child ? (
                      <SidebarProjectThreadName thread={row.child}>
                        {sidebarThreadTitle(row.child.source)}
                      </SidebarProjectThreadName>
                    ) : (
                      name
                    )}
                  </RowLabel>
                  {sameProgram ? <span className="shrink-0 text-2xs">×{sameProgram}</span> : null}
                </span>
              }
              wideName={row.kind !== "subagent"}
              count={toggle && !toggle.open ? toggle.count : undefined}
              time={time}
              status={<ThreadStatusMark status={status} />}
            />
          ) : (
            <>
              {locationIcon}
              {roleIcon}
              {icon}
              <RowLabel
                className="fork-sidebar-title min-w-0 flex-1 truncate text-foreground/85"
                command={nameDetail}
              >
                {name}
              </RowLabel>
              {sameProgram ? <span className="shrink-0">×{sameProgram}</span> : null}
              {props.compact ? null : (
                <span className="shrink-0 text-muted-foreground">{kindLabel}</span>
              )}
              {status === "approval" || status === "input" ? (
                <span className="flex w-12 shrink-0 justify-end">
                  <ThreadStatusMark status={status} />
                </span>
              ) : row.kind === "subagent" && row.child ? (
                <span className="w-12 shrink-0 text-right text-muted-foreground">{time}</span>
              ) : row.startedAt ? (
                <span className="w-12 shrink-0 text-right text-muted-foreground">{time}</span>
              ) : null}
              {row.kind !== "subagent" ? <ThreadStatusMark status="working" /> : null}
            </>
          );
          const element =
            row.kind === "subagent" && childThreadId ? (
              <SidebarChildWorkButton
                environmentId={props.environmentId}
                threadId={childThreadId}
                className={cn(
                  "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md text-left hover:bg-accent",
                  PROJECTS_WORK_ROW_HEIGHT,
                  rowClass,
                )}
                onClick={(event) => {
                  if (row.child && props.onChildClick) {
                    props.onChildClick(event, row.child);
                    return;
                  }
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(
                      scopeThreadRef(props.environmentId, childThreadId),
                    ),
                  });
                }}
                // Drag the row onto a chat composer to add the subagent's thread as context.
                onPointerDown={(event) => {
                  draggedChild.current = { threadId: childThreadId, title: row.label };
                  childDrag.onPointerDown(event);
                }}
                onClickCapture={childDrag.onClickCapture}
                onContextMenu={(event) => {
                  if (!row.child || !props.onChildContextMenu) return;
                  event.preventDefault();
                  props.onChildContextMenu(row.child, { x: event.clientX, y: event.clientY });
                }}
              >
                {content}
              </SidebarChildWorkButton>
            ) : row.kind !== "subagent" && processOutput ? (
              <BackgroundProcessOutputButton
                environmentId={props.environmentId}
                threadId={taskThreadId}
                taskId={row.taskId}
                label={row.label}
                command={row.command}
                startedAt={row.startedAt}
                commandKind={row.commandKind}
                followable={row.followable}
                className={cn(
                  "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md text-left hover:bg-accent",
                  PROJECTS_WORK_ROW_HEIGHT,
                  rowClass,
                )}
              >
                {content}
              </BackgroundProcessOutputButton>
            ) : (
              <div
                className={cn(
                  "flex min-w-0 items-center gap-2",
                  PROJECTS_WORK_ROW_HEIGHT,
                  rowClass,
                )}
              >
                {content}
              </div>
            );

          return (
            <li
              ref={nested?.ref}
              data-family-separator={props.familySeparators?.get(
                sidebarSubagentRowKey(props.environmentId, props.threadId, row),
              )}
              data-thread-item={
                childThreadId
                  ? scopedThreadKey(scopeThreadRef(props.environmentId, childThreadId))
                  : undefined
              }
              className={cn(
                row.kind !== "subagent" && "group/shell",
                index > 0 &&
                  row.kind === "subagent" &&
                  rows[index - 1]!.kind !== "subagent" &&
                  cn(
                    "border-t",
                    props.columns && familyStyle === "lines"
                      ? "border-transparent"
                      : "border-sidebar-border/40",
                  ),
                "fork-sidebar-agent-item relative",
              )}
              style={
                props.columns
                  ? ({ "--sidebar-thread-depth": props.depth ?? 0 } as CSSProperties)
                  : undefined
              }
            >
              {props.columns && row.kind === "subagent" && row.child ? (
                <SidebarProjectThreadTooltip
                  thread={row.child}
                  provider={provider}
                  render={element}
                />
              ) : props.compact ? (
                <Tooltip>
                  <TooltipTrigger render={element} />
                  <TooltipPopup side="right">
                    {row.label} · {kindLabel}
                    {modelLabel ? (
                      <>
                        <br />
                        Selected model and effort: {modelLabel}
                      </>
                    ) : null}
                    {worktree ? (
                      <>
                        <br />
                        Worktree: {worktree}
                      </>
                    ) : null}
                  </TooltipPopup>
                </Tooltip>
              ) : (
                element
              )}
              {row.kind !== "subagent" && row.followable !== false ? (
                <StopBackgroundShellButton
                  environmentId={props.environmentId}
                  threadId={taskThreadId}
                  taskId={row.taskId}
                  label={row.label}
                  className={cn(
                    "fork-sidebar-stop",
                    STOP_SHELL_ON_ROW_HOVER_CLASS,
                    props.columns ? "end-1.5" : "end-0.5",
                  )}
                />
              ) : null}
              {toggle ? (
                <SidebarCaretToggle
                  open={toggle.open}
                  label={`${toggle.open ? "Hide" : "Show"} ${toggle.count} running ${toggle.count === 1 ? "task" : "tasks"} under ${row.label}`}
                  onToggle={toggle.onToggle}
                  className="top-0.5 h-5"
                />
              ) : null}
              {toggle === null || toggle.open ? nested?.children : null}
            </li>
          );
        };
        return [
          ...(index === afterTasksAt
            ? [<Fragment key="after-tasks">{props.afterTasks}</Fragment>]
            : []),
          <Fragment key={row.taskId}>
            {row.kind === "subagent" && props.renderAgent
              ? props.renderAgent(row, renderRow)
              : renderRow(null)}
          </Fragment>,
        ];
      })}
      {afterTasksAt === -1 ? props.afterTasks : null}
    </ul>
  );
}

function SidebarChildWorkButton({
  environmentId,
  threadId,
  className,
  ...props
}: ComponentProps<"button"> & {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const key = scopedThreadKey(scopeThreadRef(environmentId, threadId));
  const selected = useThreadSelectionStore((store) => store.selectedThreadKeys.has(key));
  return (
    <button
      type="button"
      {...props}
      className={cn(className, selected && "bg-sidebar-row-selected")}
    />
  );
}
