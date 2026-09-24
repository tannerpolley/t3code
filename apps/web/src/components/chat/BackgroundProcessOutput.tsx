import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useLayoutEffect, useRef, type ComponentProps } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

interface BackgroundProcessTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly taskId: string;
  readonly label: string;
}

/**
 * A background process row that opens its live output. Pass the row's content as children and
 * its classes as `className`; other button props (a tooltip trigger's) pass through.
 */
export function BackgroundProcessOutputButton(
  props: BackgroundProcessTarget & Omit<ComponentProps<"button">, "type">,
) {
  const { environmentId, threadId, taskId, label, ...buttonProps } = props;
  return (
    <Popover>
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
