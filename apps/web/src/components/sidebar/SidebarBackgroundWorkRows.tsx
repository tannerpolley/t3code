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
import {
  BackgroundTaskResourceUsageLabel,
  backgroundTaskResourceUsageKey,
  useBackgroundTaskListVisibility,
  useBackgroundTaskResourceUsage,
} from "../chat/BackgroundTaskUsage";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import type { SidebarThreadSummary } from "../../types";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import {
  SidebarCaretToggle,
  SidebarThreadColumns,
  sidebarThreadName,
  SidebarTokenUsage,
  PROJECTS_WORK_ROW_HEIGHT,
} from "./SidebarColumns";
import { ThreadStatusMark } from "../ThreadStatusMark";
import { AgentElapsed } from "../chat/AgentElapsed";
import { SidebarThreadTime } from "./SidebarThreadTime";
import { useThreadContextPointerDrag } from "../chat/threadContextDrag";
import {
  childWorktreeLabel,
  groupBackgroundWorkTaskRows,
  resolveSidebarThreadModelLabel,
  sidebarThreadTitle,
  type BackgroundWorkTaskRow,
} from "./SidebarBackgroundWork.logic";
import { ThreadRelationshipIcon } from "../chat/ThreadRelationshipIcon";
import { ThreadLocationIcon } from "../ThreadLocationIcon";
import { ThreadRoleIcon } from "../ThreadRoleIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type NestedWorkToggle = {
  readonly count: number;
  readonly open: boolean;
  readonly onToggle: () => void;
};

export type SidebarBackgroundWorkRowsProps = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly rows: ReadonlyArray<BackgroundWorkTaskRow>;
  readonly compact?: boolean;
  readonly columns?: boolean;
  /** Threads that carry their location's icon; without it every subagent row shows its own. */
  readonly locationLeadKeys?: ReadonlySet<string> | undefined;
  /** Nesting level of these rows below their top-level thread, which sets their tint's shade. */
  readonly depth?: number;
  readonly renderNested?: (row: BackgroundWorkTaskRow) => ReactNode;
  readonly nestedToggle?: (row: BackgroundWorkTaskRow) => NestedWorkToggle | null;
  readonly onChildClick?: (event: ReactMouseEvent, thread: SidebarThreadSummary) => void;
  readonly onChildContextMenu?: (
    thread: SidebarThreadSummary,
    position: { readonly x: number; readonly y: number },
  ) => void;
};

/** Subagent and background task rows in the sidebar's shared thread columns. */
export function SidebarBackgroundWorkRows(props: SidebarBackgroundWorkRowsProps) {
  const navigate = useNavigate();
  const providers = useServerConfigs().get(props.environmentId)?.providers;
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
  const rows = props.rows;
  const { backgroundTasks } = groupBackgroundWorkTaskRows(rows);
  const processOutput = useClientSettings((settings) => settings.backgroundProcessOutput);
  const shortModelNames = useClientSettings((settings) => settings.shortModelNames);
  const { listRef, isVisible } = useBackgroundTaskListVisibility(backgroundTasks.length > 0);
  const resourceUsage = useBackgroundTaskResourceUsage({
    environmentId: props.environmentId,
    threadIds: backgroundTasks.map((row) => row.ownerThreadId ?? props.threadId),
    enabled: isVisible,
  });
  // Column rows take their group's tint, at their depth.
  const rowClass = props.columns ? "rounded-md px-2 sidebar-thread-tint" : "px-1.5";

  return (
    <ul
      ref={listRef}
      className={
        props.columns
          ? "text-2xs"
          : props.compact
            ? "max-h-40 overflow-y-auto text-2xs"
            : "max-h-48 space-y-0.5 overflow-y-auto pb-1 text-xs"
      }
    >
      {rows.map((row, index) => {
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
        const usage =
          row.kind === "subagent" ? null : (
            <BackgroundTaskResourceUsageLabel
              usage={resourceUsage.get(backgroundTaskResourceUsageKey(taskThreadId, row.taskId))}
            />
          );
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
              className={props.columns ? "size-4" : "size-3.5"}
            />
          );
        const toggle =
          props.columns && row.kind === "subagent" ? (props.nestedToggle?.(row) ?? null) : null;
        const worktree =
          row.kind === "subagent" && row.child ? childWorktreeLabel(row.child, owner) : null;
        // In Projects only each location's lead carries the icon; other cells stay empty.
        const locationIcon =
          row.kind === "subagent" &&
          row.child &&
          props.locationLeadKeys?.has(
            scopedThreadKey(scopeThreadRef(props.environmentId, row.child.id)),
          ) !== false ? (
            <ThreadLocationIcon thread={row.child} />
          ) : null;
        const roleIcon =
          row.kind === "subagent" && row.child ? (
            <ThreadRoleIcon thread={row.child.source} />
          ) : null;
        const modelLabel =
          row.kind === "subagent" && row.child
            ? resolveSidebarThreadModelLabel(row.child, provider, shortModelNames)
            : null;
        const time =
          row.kind === "subagent" && row.child ? (
            <SidebarThreadTime
              thread={row.child}
              {...(row.status === undefined ? {} : { status: row.status })}
            />
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
                <span className="min-w-0 flex-1 truncate">
                  {row.kind === "subagent"
                    ? sidebarThreadName(
                        row.label,
                        row.child ? sidebarThreadTitle(row.child.source) : "Subagent",
                      )
                    : row.label}
                </span>
                {row.kind === "subagent" ? null : usage}
              </span>
            }
            count={toggle && !toggle.open ? toggle.count : undefined}
            time={time}
            status={<ThreadStatusMark status={row.status ?? "working"} />}
            usage={
              row.kind === "subagent" && row.child ? (
                <SidebarTokenUsage
                  summary={row.child.source.usageSummary}
                  driver={provider?.driver}
                />
              ) : undefined
            }
          />
        ) : (
          <>
            {locationIcon}
            {roleIcon}
            {icon}
            <span className="min-w-0 flex-1 truncate text-foreground/85">{row.label}</span>
            {usage}
            {props.compact ? null : (
              <span className="shrink-0 text-muted-foreground">{kindLabel}</span>
            )}
            {row.status === "approval" || row.status === "input" ? (
              <span className="flex w-12 shrink-0 justify-end">
                <ThreadStatusMark status={row.status} />
              </span>
            ) : row.kind === "subagent" && row.child ? (
              <span className="w-12 shrink-0 text-right text-muted-foreground">{time}</span>
            ) : row.startedAt ? (
              <span className="w-12 shrink-0 text-right text-muted-foreground">{time}</span>
            ) : null}
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
              className={cn("flex min-w-0 items-center gap-2", PROJECTS_WORK_ROW_HEIGHT, rowClass)}
            >
              {content}
            </div>
          );

        return (
          <li
            key={row.taskId}
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
                "border-t border-sidebar-border/40",
              "relative",
            )}
            style={
              props.columns
                ? ({ "--sidebar-thread-depth": props.depth ?? 0 } as CSSProperties)
                : undefined
            }
          >
            {props.compact ? (
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
            {row.kind !== "subagent" ? (
              <StopBackgroundShellButton
                environmentId={props.environmentId}
                threadId={taskThreadId}
                taskId={row.taskId}
                label={row.label}
                className={cn(STOP_SHELL_ON_ROW_HOVER_CLASS, props.columns ? "end-1.5" : "end-0.5")}
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
            {toggle === null || toggle.open ? props.renderNested?.(row) : null}
          </li>
        );
      })}
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
