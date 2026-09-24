import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, TerminalIcon } from "lucide-react";

import { useClientSettings } from "../../hooks/useSettings";
import { useServerConfigs, useThreadProjection, useThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadStatusMark } from "../ThreadStatusMark";
import { AgentElapsed } from "./AgentElapsed";
import { BackgroundProcessOutputButton } from "./BackgroundProcessOutput";
import {
  type BackgroundWorkTaskRow,
  describeBackgroundWorkTasks,
} from "./BackgroundWorkTaskList.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { resolveSubagentModelLabel } from "./SubagentTooltipContent";
import { ThreadRelationshipIcon } from "./ThreadRelationshipIcon";

/**
 * One row per pending background task; subagents with a thread open it like their Lineage row.
 * `compact` fits the sidebar: smaller text, and the kind moves into the row's tooltip.
 * `columns` lays rows out like a Lineage row (icon, model · effort or label, elapsed, status mark)
 * with the Codex-style sidebar's fixed time and status slots, so they line up with thread rows.
 */
export function BackgroundWorkTaskList(props: {
  readonly environmentId: EnvironmentId;
  /** The thread that owns these tasks; process rows open its task output. */
  readonly threadId: ThreadId;
  readonly rows: ReadonlyArray<BackgroundWorkTaskRow>;
  readonly compact?: boolean;
  readonly columns?: boolean;
}) {
  const navigate = useNavigate();
  // Columns match the sidebar thread row's px-2, so time and status slots share a right edge.
  const padding = props.columns ? "px-2" : "px-1.5";
  const providers = useServerConfigs().get(props.environmentId)?.providers;
  const shortModelNames = useClientSettings((settings) => settings.shortModelNames);
  return (
    <ul
      className={
        props.compact
          ? "max-h-40 overflow-y-auto text-[11px]"
          : "max-h-48 space-y-0.5 overflow-y-auto pb-1 text-xs"
      }
    >
      {props.rows.map((row) => {
        const Icon = row.kind === "subagent" ? BotIcon : TerminalIcon;
        const kindLabel = row.kind === "subagent" ? "Subagent" : "Background process";
        const provider = row.child
          ? providers?.find((entry) => entry.instanceId === row.child?.providerInstanceId)
          : undefined;
        const content = props.columns ? (
          <>
            {row.child ? (
              <ThreadRelationshipIcon driver={provider?.driver} provider={provider} />
            ) : (
              <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate text-foreground/85">
              {row.child ? (
                <>
                  {resolveSubagentModelLabel(
                    { model: null, provider, childThread: row.child },
                    { shortName: shortModelNames },
                  )}
                  <span className="sr-only">, {row.label}</span>
                </>
              ) : (
                row.label
              )}
            </span>
            <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">
              {row.startedAt ? (
                <AgentElapsed
                  agent={{ status: "running", startedAt: row.startedAt, completedAt: null }}
                />
              ) : null}
            </span>
            <ThreadStatusMark status={row.status ?? "working"} />
          </>
        ) : (
          <>
            <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
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
                <AgentElapsed
                  agent={{ status: "running", startedAt: row.startedAt, completedAt: null }}
                />
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
        ) : row.kind === "process" ? (
          // Opens the process's live output (Claude background shells write it to a file).
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
          <li key={row.taskId}>
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
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Thread details block for the thread's pending non-agent background work (Claude background
 * shells and monitors, Codex background terminals), which Lineage leaves out. Hidden when empty.
 */
export function ThreadBackgroundProcessesPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const tasks = useThreadShell(ref)?.pendingBackgroundTasks ?? [];
  const projection = useThreadProjection(ref)?.projection ?? null;
  const rows =
    tasks.length === 0 || projection === null
      ? []
      : describeBackgroundWorkTasks(tasks, projection).filter((row) => row.kind === "process");
  if (rows.length === 0) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-background-processes-heading"
      title="Background processes"
    >
      <BackgroundWorkTaskList
        compact
        environmentId={props.environmentId}
        threadId={props.threadId}
        rows={rows}
      />
    </ThreadDetailsSection>
  );
}
