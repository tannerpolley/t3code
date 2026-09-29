import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadStatusMark } from "../ThreadStatusMark";
import { AgentElapsed } from "./AgentElapsed";
import {
  BackgroundProcessOutputButton,
  BackgroundShellElapsed,
  StopBackgroundShellButton,
  STOP_SHELL_ON_ROW_HOVER_CLASS,
} from "./BackgroundProcessOutput";
import type { BackgroundWorkTaskRow } from "./BackgroundWorkTaskList.logic";
import { resolveSubagentModelLabel } from "./SubagentTooltipContent";
import { ThreadRelationshipIcon } from "./ThreadRelationshipIcon";

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
  /** The thread that owns these tasks; process rows open its task output. */
  readonly threadId: ThreadId;
  readonly rows: ReadonlyArray<BackgroundWorkTaskRow>;
  readonly compact?: boolean;
  readonly columns?: boolean;
  /** Columns rows under another columns row, whose icon sits lower in a shorter row. */
  readonly nested?: boolean;
  readonly renderNested?: (row: BackgroundWorkTaskRow) => ReactNode;
}) {
  const navigate = useNavigate();
  // Columns match the sidebar thread row's px-2, so time and status slots share a right edge.
  const padding = props.columns ? "px-2" : "px-1.5";
  const providers = useServerConfigs().get(props.environmentId)?.providers;
  const shortModelNames = useClientSettings((settings) => settings.shortModelNames);
  const processOutput = useClientSettings((settings) => settings.backgroundProcessOutput);
  // An agent task without its own thread runs on the owner's provider, so it shows that icon.
  const ownerInstanceId = useThreadShell(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.providerInstanceId;
  const ownerProvider = providers?.find((entry) => entry.instanceId === ownerInstanceId);
  return (
    <ul
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
        const provider = row.child
          ? providers?.find((entry) => entry.instanceId === row.child?.providerInstanceId)
          : ownerProvider;
        const icon =
          row.kind === "process" ? (
            <TerminalIcon
              aria-hidden
              className={cn(
                "shrink-0 text-muted-foreground",
                props.columns ? "size-4" : "size-3.5",
              )}
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
            <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">
              {row.startedAt ? elapsed(row.kind, row.startedAt) : null}
            </span>
            <ThreadStatusMark status={row.status ?? "working"} />
          </>
        ) : (
          <>
            {icon}
            <span className="min-w-0 flex-1 truncate text-foreground/85">{row.label}</span>
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
            threadId={props.threadId}
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
                </TooltipPopup>
              </Tooltip>
            ) : (
              element
            )}
            {row.kind === "process" ? (
              <StopBackgroundShellButton
                environmentId={props.environmentId}
                threadId={props.threadId}
                taskId={row.taskId}
                label={row.label}
                className={cn(STOP_SHELL_ON_ROW_HOVER_CLASS, props.columns ? "end-1.5" : "end-0.5")}
              />
            ) : null}
            {props.renderNested?.(row)}
          </li>
        );
      })}
    </ul>
  );
}
