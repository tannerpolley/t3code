import type {
  EnvironmentId,
  OrchestrationV2BackgroundTaskResourceUsage,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function backgroundTaskResourceUsageKey(threadId: ThreadId, taskId: string): string {
  return `${threadId}\0${taskId}`;
}

export function useBackgroundTaskListVisibility(enabled: boolean) {
  const [element, setElement] = useState<Element | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (element === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry?.isIntersecting === true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return { listRef: setElement, isVisible: enabled && visible };
}

export function useBackgroundTaskResourceUsage(input: {
  readonly environmentId: EnvironmentId;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly enabled: boolean;
}) {
  const query = useEnvironmentQuery(
    input.enabled
      ? serverEnvironment.backgroundTaskResourceUsage({
          environmentId: input.environmentId,
          input: { threadIds: [...new Set(input.threadIds)].sort() },
        })
      : null,
  );
  return useMemo(
    () =>
      new Map(
        (query.data ?? []).map((usage) => [
          backgroundTaskResourceUsageKey(usage.threadId, usage.taskId),
          usage,
        ]),
      ),
    [query.data],
  );
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function BackgroundTaskResourceUsageLabel(props: {
  readonly usage: OrchestrationV2BackgroundTaskResourceUsage | undefined;
  readonly className?: string;
}) {
  const cpuPercent = props.usage?.cpuPercent;
  const residentBytes = props.usage?.residentBytes;
  if (cpuPercent == null || residentBytes == null) return null;
  const cpu = `${cpuPercent.toFixed(1)}%`;
  const memory = formatBytes(residentBytes);
  const label = `${cpu} · ${memory}`;
  const detail = `CPU ${cpu}, RAM ${memory}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={detail}
            className={cn(
              "min-w-[3.5rem] shrink-0 whitespace-nowrap text-right text-[10px] text-muted-foreground tabular-nums",
              props.className,
            )}
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="right">{detail}</TooltipPopup>
    </Tooltip>
  );
}
