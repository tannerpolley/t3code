import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SquareIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { terminalEnvironment } from "../../state/terminal";
import { readProject, readThreadShell } from "../../state/entities";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { useAtomCommand } from "../../state/use-atom-command";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { msUntilPossiblyStuck } from "../sidebar/SidebarBackgroundWork.logic";

interface BackgroundProcessTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly taskId: string;
  readonly label: string;
}

/**
 * Opens a background shell in a tab of its thread's terminal drawer that follows its output, and
 * shows that thread. One tab per shell: a second click returns to it. Resolves false when no tab
 * could be opened (no project, or the server can't follow this shell).
 */
function useFollowBackgroundProcessInTerminal() {
  const navigate = useNavigate();
  const follow = useAtomCommand(terminalEnvironment.followBackgroundTask, {
    reportFailure: false,
  });
  return async (target: BackgroundProcessTarget): Promise<boolean> => {
    const threadRef = scopeThreadRef(target.environmentId, target.threadId);
    const thread = readThreadShell(threadRef);
    const project = thread
      ? readProject(scopeProjectRef(target.environmentId, thread.projectId))
      : null;
    if (!thread || !project) return false;
    const launch = { project: { cwd: project.workspaceRoot }, worktreePath: thread.worktreePath };
    const terminalId = `bg-${target.taskId}`.slice(0, 128);
    const store = useTerminalUiStateStore.getState();
    const known = selectThreadTerminalUiState(
      store.terminalUiStateByThreadKey,
      threadRef,
    ).terminalIds.includes(terminalId);
    if (!known) {
      const result = await follow({
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          terminalId,
          taskId: target.taskId,
          cwd: projectScriptCwd(launch),
          env: projectScriptRuntimeEnv(launch),
          ...(thread.worktreePath === null ? {} : { worktreePath: thread.worktreePath }),
          ...(thread.providerInstanceId === null
            ? {}
            : { providerInstanceId: thread.providerInstanceId }),
        },
      });
      if (result._tag === "Failure") return false;
    }
    store.ensureTerminal(threadRef, terminalId, { open: true });
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
    return true;
  };
}

/**
 * A background process row. A click opens the process in a terminal tab that follows its output;
 * where that isn't possible, it opens the live output in a popover instead. Pass the row's
 * content as children and its classes as `className`; other button props (a tooltip trigger's)
 * pass through.
 */
export function BackgroundProcessOutputButton(
  props: BackgroundProcessTarget & Omit<ComponentProps<"button">, "type">,
) {
  const { environmentId, threadId, taskId, label, ...buttonProps } = props;
  const [open, setOpen] = useState(false);
  const followInTerminal = useFollowBackgroundProcessInTerminal();
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setOpen(false);
          return;
        }
        void followInTerminal({ environmentId, threadId, taskId, label }).then((followed) => {
          if (!followed) setOpen(true);
        });
      }}
    >
      <PopoverTrigger {...buttonProps} />
      <PopoverPopup side="right" align="start" className="w-[min(40rem,90vw)]">
        <BackgroundProcessOutputView
          environmentId={environmentId}
          threadId={threadId}
          taskId={taskId}
          label={label}
        />
      </PopoverPopup>
    </Popover>
  );
}

/** Mounted only while open: the subscription, and the server's file tail, end on unmount. */
function BackgroundProcessOutputView(props: BackgroundProcessTarget) {
  const output = useEnvironmentQuery(
    orchestrationEnvironment.backgroundTaskOutput({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, taskId: props.taskId },
    }),
  );
  const text = output.data ?? "";
  const scrollRef = useRef<HTMLPreElement>(null);
  const pinnedToBottom = useRef(true);
  // Follow new output unless the reader scrolled up; renders only happen when output changes.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && pinnedToBottom.current) element.scrollTop = element.scrollHeight;
  });

  return (
    <div className="space-y-2">
      <p className="truncate font-medium text-sm">{props.label}</p>
      {output.error ? (
        <p className="text-destructive text-xs">{output.error}</p>
      ) : (
        <pre
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            pinnedToBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 16;
          }}
          className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-2 font-mono text-2xs leading-relaxed"
        >
          {text.length > 0 ? text : <span className="text-muted-foreground">No output yet.</span>}
        </pre>
      )}
    </div>
  );
}

/**
 * How long a background shell has run. Past the possibly-stuck threshold it turns amber with a
 * hint; one timer flips it there, while `AgentElapsed` keeps its own ticking.
 */
export function BackgroundShellElapsed(props: {
  readonly startedAt: string;
  readonly commandKind?: string | undefined;
}) {
  // Rows are keyed by task, so a shell's start never changes under this state.
  const [stuck, setStuck] = useState(() => msUntilPossiblyStuck(props.startedAt, Date.now()) === 0);
  useEffect(() => {
    if (stuck || props.commandKind === "server") return;
    const id = setTimeout(() => setStuck(true), msUntilPossiblyStuck(props.startedAt, Date.now()));
    return () => clearTimeout(id);
  }, [props.startedAt, props.commandKind, stuck]);
  const elapsed = (
    <AgentElapsed agent={{ status: "running", startedAt: props.startedAt, completedAt: null }} />
  );
  if (!stuck || props.commandKind === "server") return elapsed;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="text-warning-foreground" />}>
        {elapsed}
      </TooltipTrigger>
      <TooltipPopup className="max-w-72">
        Possibly stuck: running for over 2 hours. A wait loop such as{" "}
        <code>until ! pgrep -f …</code> can match itself and never end. Stop it if it should have
        finished.
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Places a row's stop button over its status mark, shown while the row (a `group/shell`) is
 * hovered or the button has focus. Callers add the horizontal inset.
 */
export const STOP_SHELL_ON_ROW_HOVER_CLASS =
  "pointer-events-none absolute top-0.5 bg-accent opacity-0 group-hover/shell:pointer-events-auto group-hover/shell:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100";

/**
 * Stops one background shell through the provider session running it. It sits beside the row's
 * own button (buttons cannot nest), so a click here never opens the output.
 */
export function StopBackgroundShellButton(
  props: BackgroundProcessTarget & { readonly className?: string },
) {
  const stop = useAtomCommand(orchestrationEnvironment.stopBackgroundTask, {
    reportFailure: false,
  });
  const [stopping, setStopping] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Stop ${props.label}`}
            disabled={stopping}
            className={cn(
              "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive disabled:cursor-default disabled:opacity-50",
              props.className,
            )}
            onClick={async (event) => {
              event.stopPropagation();
              setStopping(true);
              const result = await stop({
                environmentId: props.environmentId,
                input: { threadId: props.threadId, taskId: props.taskId },
              });
              setStopping(false);
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                const error = squashAtomCommandFailure(result);
                toastManager.add({
                  type: "error",
                  title: "Could not stop the task",
                  description: error instanceof Error ? error.message : "An error occurred.",
                });
              }
            }}
          />
        }
      >
        <SquareIcon aria-hidden className="size-3 fill-current" />
      </TooltipTrigger>
      <TooltipPopup>Stop this task</TooltipPopup>
    </Tooltip>
  );
}
