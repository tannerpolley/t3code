import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, TerminalIcon } from "lucide-react";

import { buildThreadRouteParams } from "../../threadRoutes";
import { AgentElapsed } from "./AgentElapsed";
import type { BackgroundWorkTaskRow } from "./BackgroundWorkTaskList.logic";

/** One row per pending background task; subagents with a thread open it like their Lineage row. */
export function BackgroundWorkTaskList(props: {
  readonly environmentId: EnvironmentId;
  readonly rows: ReadonlyArray<BackgroundWorkTaskRow>;
}) {
  const navigate = useNavigate();
  return (
    <ul className="max-h-48 space-y-0.5 overflow-y-auto pb-1 text-xs">
      {props.rows.map((row) => {
        const Icon = row.kind === "subagent" ? BotIcon : TerminalIcon;
        const content = (
          <>
            <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-foreground/85">{row.label}</span>
            <span className="shrink-0 text-muted-foreground">
              {row.kind === "subagent" ? "Subagent" : "Background process"}
            </span>
            {row.startedAt ? (
              <span className="w-12 shrink-0 text-right text-muted-foreground">
                <AgentElapsed
                  agent={{ status: "running", startedAt: row.startedAt, completedAt: null }}
                />
              </span>
            ) : null}
          </>
        );
        const childThreadId = row.childThreadId;
        return (
          <li key={row.taskId}>
            {childThreadId ? (
              <button
                type="button"
                className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent"
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(
                      scopeThreadRef(props.environmentId, childThreadId),
                    ),
                  })
                }
              >
                {content}
              </button>
            ) : (
              <div className="flex min-w-0 items-center gap-2 px-1.5 py-1">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
