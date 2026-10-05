import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CornerDownRightIcon, FolderGit2Icon } from "lucide-react";
import { useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

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
  SidebarCaretSlot,
  SidebarCaretToggle,
  SidebarTrailingColumns,
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
  type BackgroundWorkTaskRow,
} from "./SidebarBackgroundWork.logic";
import { ThreadRelationshipIcon } from "../chat/ThreadRelationshipIcon";
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
  /** Rows nested below another columns row, whose caret sits lower in the shorter row. */
  readonly nested?: boolean;
  readonly renderNested?: (row: BackgroundWorkTaskRow) => ReactNode;
  readonly nestedToggle?: (row: BackgroundWorkTaskRow) => NestedWorkToggle | null;
  readonly onChildClick?: (event: ReactMouseEvent, thread: SidebarThreadSummary) => void;
  readonly onChildContextMenu?: (
    thread: SidebarThreadSummary,
    position: { readonly x: number; readonly y: number },
  ) => void;
};

/** Marks a child thread that works in its own worktree; its row's tooltip names the branch. */
export function ChildWorktreeIcon() {
  return <FolderGit2Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" />;
}

/** Subagent and background task rows in the sidebar's shared thread columns. */
export function SidebarBackgroundWorkRows(props: SidebarBackgroundWorkRowsProps) {
  const navigate = useNavigate();
  const selectedThreadKeys = useThreadSelectionStore((store) => store.selectedThreadKeys);
  const providers = useServerConfigs().get(props.environmentId)?.providers;
  const owner = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const ownerProvider = providers?.find((entry) => entry.instanceId === owner?.providerInstanceId);
  // One drag at a time, so the list shares one drag and notes which subagent row started it.
  const draggedChild = useRef<{ readonly threadId: ThreadId; readonly title: string } | null>(
    null,
  );
  const childDrag = useThreadContextPointerDrag(() => ({
    threads: draggedChild.current
      ? [scopeThreadRef(props.environmentId, draggedChild.current.threadId)]
      : [],
    title: draggedChild.current?.title ?? "Thread",
  }));
  const { agents, backgroundTasks } = groupBackgroundWorkTaskRows(props.rows);
  const rows = [...agents, ...backgroundTasks];
  const processOutput = useClientSettings((settings) => settings.backgroundProcessOutput);
  const shortModelNames = useClientSettings((settings) => settings.shortModelNames);
  const { listRef, isVisible } = useBackgroundTaskListVisibility(backgroundTasks.length > 0);
  const resourceUsage = useBackgroundTaskResourceUsage({
    environmentId: props.environmentId,
    threadIds: backgroundTasks.map((row) => row.ownerThreadId ?? props.threadId),
    enabled: isVisible,
  });
  const padding = props.columns ? "px-2" : "px-1.5";

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
            ? "Subagent"
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
        const worktreeIcon = worktree ? <ChildWorktreeIcon /> : null;
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
              elapsed(row.startedAt)
            ) : (
              <BackgroundShellElapsed startedAt={row.startedAt} commandKind={row.commandKind} />
            )
          ) : null;
        const content = props.columns ? (
          <>
            {/* The worktree mark takes the empty caret slot unless a toggle sits over it. */}
            {toggle ? (
              <>
                <SidebarCaretSlot />
                {worktreeIcon}
              </>
            ) : (
              <SidebarCaretSlot>{worktreeIcon}</SidebarCaretSlot>
            )}
            {icon}
            {modelLabel ? (
              // Gives way before the label, as in the thread row above it.
              <span className="hidden min-w-0 max-w-[6.5rem] shrink-[100] truncate text-foreground/85 @min-[16rem]/work-row:block">
                {modelLabel}
              </span>
            ) : null}
            <span className="min-w-0 flex-[1_1_5rem] truncate text-foreground/85">{row.label}</span>
            {usage}
            <SidebarTrailingColumns
              count={toggle && !toggle.open ? toggle.count : undefined}
              time={time}
              status={<ThreadStatusMark status={row.status ?? "working"} />}
            />
          </>
        ) : (
          <>
            {worktreeIcon}
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
            <button
              type="button"
              className={cn(
                "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md text-left hover:bg-accent",
                PROJECTS_WORK_ROW_HEIGHT,
                padding,
                selectedThreadKeys.has(
                  scopedThreadKey(scopeThreadRef(props.environmentId, childThreadId)),
                ) && "bg-sidebar-row-selected",
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
            </button>
          ) : row.kind !== "subagent" && processOutput ? (
            <BackgroundProcessOutputButton
              environmentId={props.environmentId}
              threadId={taskThreadId}
              taskId={row.taskId}
              label={row.label}
              className={cn(
                "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md text-left hover:bg-accent",
                PROJECTS_WORK_ROW_HEIGHT,
                padding,
              )}
            >
              {content}
            </BackgroundProcessOutputButton>
          ) : (
            <div
              className={cn("flex min-w-0 items-center gap-2", PROJECTS_WORK_ROW_HEIGHT, padding)}
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
              index === agents.length && agents.length > 0 && "border-t border-sidebar-border/40",
              props.columns
                ? cn(
                    "@container/work-row relative ms-1.5 before:absolute before:-start-1.5 before:bottom-0 before:border-s before:border-sidebar-border after:absolute after:-start-1.5 after:top-3 after:w-3 after:border-t after:border-sidebar-border last:before:bottom-auto",
                    props.nested
                      ? "before:-top-1 last:before:h-4"
                      : "before:-top-2 last:before:h-5",
                  )
                : "relative",
            )}
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

function elapsed(startedAt: string) {
  return <AgentElapsed agent={{ status: "running", startedAt, completedAt: null }} />;
}
