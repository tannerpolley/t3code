import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, PlayIcon, SquareIcon, TerminalIcon } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import { cn } from "../../lib/utils";
import { shellRunOutputTail, type ShellRunMessage } from "../../lib/shellRun";
import { startShellRun, stopShellRun, useShellRunStore } from "../../state/shellRuns";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const PANEL_MAX_LINES = 200;
const RUN_LABEL = "Run in terminal and send output to the agent";

/** The ▶ button in a shell code block's toolbar. */
export function ShellRunButton(props: {
  readonly blockKey: string;
  readonly threadRef: ScopedThreadRef;
  readonly command: string;
}) {
  const running = useShellRunStore((state) => state.runs[props.blockKey]?.status === "running");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="chat-markdown-chrome-action"
            disabled={running}
            onClick={() => void startShellRun(props)}
            aria-label={RUN_LABEL}
          />
        }
      >
        <PlayIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{RUN_LABEL}</TooltipPopup>
    </Tooltip>
  );
}

/** Live output of a block's latest run, attached under the block; nothing before its first run. */
export function ShellRunPanel(props: { readonly blockKey: string }) {
  const run = useShellRunStore((state) => state.runs[props.blockKey]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  // Follow new output unless the reader scrolled up.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && pinnedToBottom.current) element.scrollTop = element.scrollHeight;
  });
  if (!run) return null;
  const running = run.status === "running";
  const { lines, hiddenLines } = shellRunOutputTail(run.output, PANEL_MAX_LINES);
  const exitCode = run.output.exitCode;
  return (
    <div className="chat-markdown-shell-run relative -mt-[0.4rem] mb-[0.65rem] overflow-hidden rounded-[var(--radius)] border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32">
      <span className="absolute top-1 right-1.5 flex items-center gap-0.5">
        {running ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  onClick={() => stopShellRun(run)}
                  aria-label="Stop"
                />
              }
            >
              <SquareIcon className="size-2.5 fill-current" />
            </TooltipTrigger>
            <TooltipPopup side="top">Stop</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="chat-markdown-chrome-action"
                onClick={() =>
                  useTerminalUiStateStore
                    .getState()
                    .ensureTerminal(run.threadRef, run.terminalId, { open: true })
                }
                aria-label="Open in terminal"
              />
            }
          >
            <TerminalIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">Open in terminal</TooltipPopup>
        </Tooltip>
      </span>
      {/* A div, not a pre: chat markdown styles every pre as a framed code block. */}
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 16;
        }}
        className="max-h-80 overflow-auto py-2 pr-16 pl-3 font-mono text-[0.75rem] break-all whitespace-pre-wrap"
      >
        {hiddenLines > 0 ? (
          <span className="text-muted-foreground">
            … {hiddenLines} earlier {hiddenLines === 1 ? "line" : "lines"}
            {"\n"}
          </span>
        ) : null}
        {lines.length > 0 ? (
          lines.join("\n")
        ) : (
          <span className="text-muted-foreground">{running ? "Running…" : "No output"}</span>
        )}
      </div>
      {(exitCode !== null && exitCode !== 0) || run.status === "ended" || run.error ? (
        <div className="px-3 pb-2 font-mono text-[0.6875rem] text-destructive/80">
          {run.error ??
            (run.status === "ended"
              ? "The terminal session ended before the command finished."
              : `Exit code ${exitCode}`)}
        </div>
      ) : null}
    </div>
  );
}

/** A sent run result in the timeline: one line that opens to the command and its output. */
export function ShellRunMessageRow(props: { readonly message: ShellRunMessage }) {
  const { command, exitCode, output, truncated } = props.message;
  const [firstLine = ""] = command.split("\n");
  return (
    <details className="group/shell-run flex max-w-[80%] min-w-0 flex-col items-end">
      <summary
        data-scroll-anchor-ignore
        className="flex max-w-full cursor-pointer list-none items-center gap-1.5 rounded-full border border-border/70 px-2.5 py-1 text-muted-foreground text-xs hover:text-foreground [&::-webkit-details-marker]:hidden"
      >
        <TerminalIcon className="size-3.5 shrink-0" />
        <span className="shrink-0">Ran</span>
        <code className="min-w-0 truncate font-mono">
          {firstLine}
          {command.includes("\n") ? " …" : ""}
        </code>
        <span className={cn("shrink-0", exitCode !== 0 && "text-destructive/80")}>
          · exit {exitCode}
        </span>
        <ChevronDownIcon className="size-3 shrink-0 transition-transform group-open/shell-run:rotate-180" />
      </summary>
      <pre className="mt-1 max-h-80 w-full overflow-auto rounded-[var(--radius)] border border-border/70 bg-secondary px-3 py-2 font-mono text-[0.75rem] leading-snug break-all whitespace-pre-wrap dark:border-transparent dark:bg-input/32">
        <span className="text-muted-foreground">
          {command
            .split("\n")
            .map((line) => `$ ${line}`)
            .join("\n")}
          {"\n"}
          {truncated ? "… earlier output was cut\n" : ""}
        </span>
        {output}
      </pre>
    </details>
  );
}
