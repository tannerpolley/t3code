import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { SquareIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { create } from "zustand";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { Popover, PopoverPopup } from "../ui/popover";
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

/** What the output popup shows about a background task or running command. */
export interface BackgroundProcessDetails extends BackgroundProcessTarget {
  readonly command?: string | undefined;
  readonly startedAt?: string | null | undefined;
  readonly commandKind?: string | undefined;
  /** False when the server can neither stream its output nor stop it alone (Claude foreground). */
  readonly followable?: boolean | undefined;
}

const processKey = (target: BackgroundProcessTarget) =>
  `${target.environmentId}\0${target.threadId}\0${target.taskId}`;

type OpenPopup = { readonly details: BackgroundProcessDetails; readonly anchor: Element };
const useOutputPopup = create<{ readonly open: OpenPopup | null }>(() => ({ open: null }));

/**
 * A background process row. A click opens a popup beside it with the process's command, status,
 * Stop and live output; a second click closes it. Pass the row's content as children and its
 * classes as `className`; other button props (a tooltip trigger's) pass through.
 */
export function BackgroundProcessOutputButton(
  props: BackgroundProcessDetails & Omit<ComponentProps<"button">, "type">,
) {
  const {
    environmentId,
    threadId,
    taskId,
    label,
    command,
    startedAt,
    commandKind,
    followable,
    onClick,
    ...buttonProps
  } = props;
  const key = processKey(props);
  const open = useOutputPopup(
    (state) => state.open !== null && processKey(state.open.details) === key,
  );
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      {...buttonProps}
      onClick={(event) => {
        onClick?.(event);
        const anchor = event.currentTarget;
        useOutputPopup.setState((state) => ({
          open:
            state.open !== null && processKey(state.open.details) === key
              ? null
              : {
                  details: {
                    environmentId,
                    threadId,
                    taskId,
                    label,
                    command,
                    startedAt,
                    commandKind,
                    followable,
                  },
                  anchor,
                },
        }));
      }}
    />
  );
}

/** The row's last place, so the popup stays put after the row leaves (its task ended). */
function lastPlaceOf(element: Element) {
  let rect = element.getBoundingClientRect();
  return {
    // Scrolling the row's container moves the popup with it.
    contextElement: element,
    getBoundingClientRect: () => {
      if (element.isConnected) rect = element.getBoundingClientRect();
      return rect;
    },
  };
}

/** The one output popup, mounted at the app root so it outlives the row that opened it. */
export function BackgroundProcessPopupHost() {
  const open = useOutputPopup((state) => state.open);
  // The closing popup keeps its content while it fades; it unmounts, with its queries, after.
  const [shown, setShown] = useState(open);
  if (open !== null && open !== shown) setShown(open);
  const anchor = useMemo(() => (shown === null ? null : lastPlaceOf(shown.anchor)), [shown]);
  return (
    <Popover
      open={open !== null}
      onOpenChange={(next, details) => {
        if (next) return;
        const target = details.event?.target;
        // A press on the opening row is left to that row's click, which toggles the popup.
        if (target instanceof Node && open?.anchor.contains(target)) return;
        useOutputPopup.setState({ open: null });
      }}
    >
      <PopoverPopup anchor={anchor} side="right" align="start" className="w-[min(40rem,90vw)]">
        {shown ? (
          <BackgroundProcessPopup key={processKey(shown.details)} {...shown.details} />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

function BackgroundProcessPopup(props: BackgroundProcessDetails) {
  // The thread's running list, polled like task usage, says when this one has ended.
  const processes = useEnvironmentQuery(
    serverEnvironment.threadProcesses({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const running = processes.data?.runningTaskIds.includes(props.taskId);
  const followable = props.followable !== false;
  const command = props.command ? commandDisplayText(props.command) : null;
  return (
    <div className="space-y-2">
      <div className="flex min-w-0 items-center gap-2">
        <p className="min-w-0 flex-1 truncate font-medium text-sm">{props.label}</p>
        {followable && running !== false ? <StopBackgroundShellButton {...props} /> : null}
      </div>
      {command && command !== props.label ? (
        <p className="line-clamp-3 break-all font-mono text-2xs text-muted-foreground">{command}</p>
      ) : null}
      <p className="flex items-center gap-1 text-2xs text-muted-foreground">
        {running === false ? (
          "Ended"
        ) : (
          <>
            {running ? <span>Running</span> : null}
            {running && props.startedAt ? <span>·</span> : null}
            {props.startedAt ? (
              <BackgroundShellElapsed startedAt={props.startedAt} commandKind={props.commandKind} />
            ) : null}
          </>
        )}
      </p>
      {followable ? (
        <BackgroundProcessOutputView {...props} />
      ) : (
        <p className="text-muted-foreground text-xs">
          Claude shows a foreground command&apos;s output when it finishes.
        </p>
      )}
    </div>
  );
}

/** Mounted only while open: the subscription, and the server's file tail, end on unmount. */
export function BackgroundProcessOutputView(props: BackgroundProcessTarget) {
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
    <div>
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
