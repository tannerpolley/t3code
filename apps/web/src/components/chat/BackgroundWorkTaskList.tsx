import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, ClockIcon, TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { syntheticFileNameForLanguageId } from "../../pierre-icons";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadStatusMark } from "../ThreadStatusMark";
import { AgentElapsed } from "./AgentElapsed";
import {
  BackgroundTaskResourceUsageLabel,
  backgroundTaskResourceUsageKey,
  useBackgroundTaskListVisibility,
  useBackgroundTaskResourceUsage,
} from "./BackgroundTaskUsage";
import {
  BackgroundProcessOutputButton,
  BackgroundShellElapsed,
  StopBackgroundShellButton,
  STOP_SHELL_ON_ROW_HOVER_CLASS,
} from "./BackgroundProcessOutput";
import { PierreEntryIcon } from "./PierreEntryIcon";
import type { BackgroundWorkTaskRow } from "./BackgroundWorkTaskList.logic";
import { resolveSubagentModelLabel } from "./SubagentTooltipContent";
import { ThreadRelationshipIcon } from "./ThreadRelationshipIcon";

const COMMAND_KIND_LABELS: Record<string, string> = {
  bash: "Bash",
  python: "Python",
  pytest: "pytest",
  uv: "uv",
  conda: "Conda",
  node: "Node.js",
  bun: "Bun",
  rust: "Rust",
  go: "Go",
  java: "Java",
  r: "R",
  julia: "Julia",
  ruby: "Ruby",
  c: "C",
  cpp: "C++",
  make: "Build",
  docker: "Docker",
  latex: "LaTeX",
  git: "Git",
  watcher: "Watcher",
};

const COMMAND_KIND_FILE: Record<string, string> = {
  bun: "bun.lockb",
  docker: "Dockerfile",
  git: ".gitignore",
  make: "Makefile",
};

const COMMAND_KIND_LANGUAGE: Record<string, string> = {
  bash: "bash",
  python: "python",
  pytest: "python",
  uv: "python",
  conda: "python",
  node: "javascript",
  rust: "rust",
  go: "go",
  java: "java",
  r: "r",
  julia: "julia",
  ruby: "ruby",
  c: "c",
  cpp: "cpp",
  latex: "latex",
};

function backgroundProcessKindLabel(taskType?: string, commandKind?: string): string {
  return taskType === "monitor" || commandKind === "watcher"
    ? "Watcher"
    : (COMMAND_KIND_LABELS[commandKind ?? ""] ?? "Shell");
}

export function BackgroundProcessKindIcon(props: {
  readonly taskType?: string | undefined;
  readonly commandKind?: string | undefined;
  readonly className: string;
}) {
  const { resolvedTheme } = useTheme();
  const label = backgroundProcessKindLabel(props.taskType, props.commandKind);
  const iconClassName = cn("size-4", props.className);
  const fileName = props.commandKind
    ? (COMMAND_KIND_FILE[props.commandKind] ??
      (COMMAND_KIND_LANGUAGE[props.commandKind] === undefined
        ? null
        : syntheticFileNameForLanguageId(COMMAND_KIND_LANGUAGE[props.commandKind]!)))
    : null;
  const icon =
    props.taskType === "monitor" || props.commandKind === "watcher" ? (
      <ClockIcon aria-hidden className={cn(iconClassName, "text-muted-foreground")} />
    ) : fileName !== null ? (
      <PierreEntryIcon
        pathValue={fileName}
        kind="file"
        theme={resolvedTheme}
        className={props.className}
      />
    ) : (
      <TerminalIcon aria-hidden className={cn(iconClassName, "text-muted-foreground")} />
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span aria-label={label} className="inline-flex shrink-0" role="img" />}
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Shells turn amber once they may be stuck; agents show plain elapsed time. */
function elapsed(kind: BackgroundWorkTaskRow["kind"], startedAt: string) {
  return kind === "process" ? (
    <BackgroundShellElapsed startedAt={startedAt} />
  ) : (
    <AgentElapsed agent={{ status: "running", startedAt, completedAt: null }} />
  );
}

/**
 * One row per pending background task; subagents with a thread open it like their Lineage row.
 * `compact` fits the sidebar: smaller text, and the kind moves into the row's tooltip.
 * `columns` lays rows out like a Lineage row (icon, model · effort or label, elapsed, status mark)
 * with the Codex-style sidebar's fixed time and status slots, so they line up with thread rows,
 * and draws tree lines from the owner's icon; `renderNested` adds a row's own subagents beneath it.
 */
export function BackgroundWorkTaskList(props: {
  readonly environmentId: EnvironmentId;
  /** Default owner; process rows can name another provider session. */
  readonly threadId: ThreadId;
  readonly rows: ReadonlyArray<BackgroundWorkTaskRow>;
  readonly compact?: boolean;
  readonly columns?: boolean;
  /** Columns rows under another columns row, whose icon sits lower in a shorter row. */
  readonly nested?: boolean;
  readonly renderNested?: (row: BackgroundWorkTaskRow) => ReactNode;
  /** A columns row's own collapsible work (its subagents and shells), shown as a count toggle. */
  readonly nestedToggle?: (
    row: BackgroundWorkTaskRow,
  ) => { readonly count: number; readonly open: boolean; readonly onToggle: () => void } | null;
}) {
  const navigate = useNavigate();
  // Columns match the sidebar thread row's px-2, so time and status slots share a right edge.
  const padding = props.columns ? "px-2" : "px-1.5";
  const providers = useServerConfigs().get(props.environmentId)?.providers;
  const shortModelNames = useClientSettings((settings) => settings.shortModelNames);
  const processOutput = useClientSettings((settings) => settings.backgroundProcessOutput);
  const hasProcesses = props.rows.some((row) => row.kind === "process");
  const { listRef, isVisible } = useBackgroundTaskListVisibility(hasProcesses);
  const taskThreadIds = [
    ...new Set(
      props.rows
        .filter((row) => row.kind === "process")
        .map((row) => row.ownerThreadId ?? props.threadId),
    ),
  ];
  const resourceUsage = useBackgroundTaskResourceUsage({
    environmentId: props.environmentId,
    threadIds: taskThreadIds,
    enabled: hasProcesses && isVisible,
  });
  // An agent task without its own thread runs on the owner's provider, so it shows that icon.
  const ownerInstanceId = useThreadShell(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.providerInstanceId;
  const ownerProvider = providers?.find((entry) => entry.instanceId === ownerInstanceId);
  return (
    <ul
      ref={listRef}
      className={
        props.columns
          ? // No scroll box: it would clip the tree lines reaching up to the owner's icon.
            "text-[11px]"
          : props.compact
            ? "max-h-40 overflow-y-auto text-[11px]"
            : "max-h-48 space-y-0.5 overflow-y-auto pb-1 text-xs"
      }
    >
      {props.rows.map((row) => {
        const kindLabel = row.kind === "subagent" ? "Subagent" : "Background process";
        const processKindLabel = backgroundProcessKindLabel(row.taskType, row.commandKind);
        const taskThreadId = row.ownerThreadId ?? props.threadId;
        const toggle = props.columns ? (props.nestedToggle?.(row) ?? null) : null;
        const provider = row.child
          ? providers?.find((entry) => entry.instanceId === row.child?.providerInstanceId)
          : ownerProvider;
        const icon =
          row.kind === "process" ? (
            <BackgroundProcessKindIcon
              taskType={row.taskType}
              commandKind={row.commandKind}
              className={props.columns ? "size-4" : "size-3.5"}
            />
          ) : (
            <ThreadRelationshipIcon driver={provider?.driver} provider={provider} />
          );
        const content = props.columns ? (
          <>
            {icon}
            {row.child ? (
              // Model then title, as on the thread rows above.
              <span className="max-w-[6.5rem] shrink-0 truncate text-foreground/85">
                {resolveSubagentModelLabel(
                  { model: null, provider, childThread: row.child },
                  { shortName: shortModelNames },
                )}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-foreground/85">{row.label}</span>
            {row.kind === "process" ? (
              <BackgroundTaskResourceUsageLabel
                usage={resourceUsage.get(backgroundTaskResourceUsageKey(taskThreadId, row.taskId))}
                className={props.columns ? "min-w-[3.5rem]" : "min-w-[3rem]"}
              />
            ) : null}
            {toggle ? (
              // Room for the toggle, which sits over this spot because buttons cannot nest.
              <span aria-hidden className="w-8 shrink-0" />
            ) : null}
            <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">
              {row.startedAt ? elapsed(row.kind, row.startedAt) : null}
            </span>
            <ThreadStatusMark status={row.status ?? "working"} />
          </>
        ) : (
          <>
            {icon}
            <span className="min-w-0 flex-1 truncate text-foreground/85">{row.label}</span>
            {row.kind === "process" ? (
              <BackgroundTaskResourceUsageLabel
                usage={resourceUsage.get(backgroundTaskResourceUsageKey(taskThreadId, row.taskId))}
                className="min-w-[3rem]"
              />
            ) : null}
            {props.compact ? null : (
              <span className="shrink-0 text-muted-foreground">{kindLabel}</span>
            )}
            {row.status === "approval" || row.status === "input" ? (
              <span className="flex w-12 shrink-0 justify-end">
                <ThreadStatusMark status={row.status} />
              </span>
            ) : row.startedAt ? (
              <span className="w-12 shrink-0 text-right text-muted-foreground">
                {elapsed(row.kind, row.startedAt)}
              </span>
            ) : null}
          </>
        );
        const childThreadId = row.childThreadId;
        const element = childThreadId ? (
          <button
            type="button"
            className={cn(
              "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md py-1 text-left hover:bg-accent",
              padding,
            )}
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(props.environmentId, childThreadId)),
              })
            }
          >
            {content}
          </button>
        ) : row.kind === "process" && processOutput ? (
          // Opens the process in a terminal tab that follows its output.
          <BackgroundProcessOutputButton
            environmentId={props.environmentId}
            threadId={taskThreadId}
            taskId={row.taskId}
            label={row.label}
            className={cn(
              "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md py-1 text-left hover:bg-accent",
              padding,
            )}
          >
            {content}
          </BackgroundProcessOutputButton>
        ) : (
          <div className={cn("flex min-w-0 items-center gap-2 py-1", padding)}>{content}</div>
        );
        return (
          <li
            key={row.taskId}
            className={
              props.columns
                ? cn(
                    // Only a shell row is a hover group, so its stop button shows on its own hover.
                    row.kind === "process" && "group/shell",
                    // Straight tree lines: a trunk from the owner's icon, an elbow to each row's
                    // middle; the last row's trunk stops at its elbow.
                    "relative ps-1.5 before:absolute before:start-0 before:bottom-0 before:border-s before:border-sidebar-border after:absolute after:start-0 after:top-3 after:w-3 after:border-t after:border-sidebar-border last:before:bottom-auto",
                    props.nested
                      ? "before:-top-1 last:before:h-4"
                      : "before:-top-2 last:before:h-5",
                  )
                : cn("relative", row.kind === "process" && "group/shell")
            }
          >
            {props.compact ? (
              <Tooltip>
                <TooltipTrigger render={element} />
                <TooltipPopup side="right">
                  {row.label} · {kindLabel}
                  {row.kind === "process" ? ` · ${processKindLabel}` : null}
                </TooltipPopup>
              </Tooltip>
            ) : (
              element
            )}
            {row.kind === "process" ? (
              <StopBackgroundShellButton
                environmentId={props.environmentId}
                threadId={taskThreadId}
                taskId={row.taskId}
                label={row.label}
                className={cn(STOP_SHELL_ON_ROW_HOVER_CLASS, props.columns ? "end-1.5" : "end-0.5")}
              />
            ) : null}
            {toggle ? (
              <button
                type="button"
                aria-expanded={toggle.open}
                aria-label={`${toggle.open ? "Hide" : "Show"} ${toggle.count} running ${toggle.count === 1 ? "task" : "tasks"} under ${row.label}`}
                className={cn(
                  "absolute top-0.5 flex h-5 w-8 cursor-pointer items-center justify-end gap-0.5 rounded px-0.5 text-[10px] text-sidebar-muted-foreground/70 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                  // Left of the time slot: 8px padding, 14px status mark, 48px time, two 8px gaps.
                  "end-[86px]",
                )}
                onClick={toggle.onToggle}
              >
                {toggle.count}
                {toggle.open ? (
                  <ChevronDownIcon aria-hidden className="size-3" />
                ) : (
                  <ChevronRightIcon aria-hidden className="size-3" />
                )}
              </button>
            ) : null}
            {toggle === null || toggle.open ? props.renderNested?.(row) : null}
          </li>
        );
      })}
    </ul>
  );
}
