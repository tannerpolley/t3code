import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";

import { readProject, readThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

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
    const terminalId = `bg-${target.taskId}`.slice(0, 128);
    const store = useTerminalUiStateStore.getState();
    const known = selectThreadTerminalUiState(
      store.terminalUiStateByThreadKey,
      threadRef,
    ).terminalIds.includes(terminalId);
    if (!known) {
      const scriptTarget = {
        project: { cwd: project.workspaceRoot },
        worktreePath: thread.worktreePath,
      };
      const result = await follow({
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          terminalId,
          taskId: target.taskId,
          cwd: projectScriptCwd(scriptTarget),
          ...(thread.worktreePath != null ? { worktreePath: thread.worktreePath } : {}),
          env: projectScriptRuntimeEnv(scriptTarget),
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
          className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed"
        >
          {text.length > 0 ? text : <span className="text-muted-foreground">No output yet.</span>}
        </pre>
      )}
    </div>
  );
}
