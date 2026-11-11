import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { useState } from "react";

import { describeSidebarBackgroundWork } from "../sidebar/SidebarBackgroundWork.logic";
import { InlineButton } from "../ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { BackgroundShellElapsed } from "./BackgroundProcessOutput";
import { BackgroundWorkTaskList } from "./BackgroundWorkTaskList";
import { CommandOutputPanel, useCommandOutputStreaming } from "./CommandOutputPanel";
import { ShellCommandBlock } from "./ShellCommandBlock";

function describeTask(
  task: OrchestrationV2PendingBackgroundTask,
  items: ThreadStructure["turnItems"],
) {
  const item = items.findLast((candidate) =>
    task.itemId === undefined
      ? (candidate.nativeItemRef?.nativeId || candidate.id) === task.taskId
      : candidate.id === task.itemId,
  );
  const command = task.command ?? (item?.type === "command_execution" ? item.input : undefined);
  const description = task.description?.trim();
  const title =
    description && description !== command?.trim()
      ? description
      : command
        ? "Command"
        : task.kind.replaceAll("_", " ");
  const itemId = task.itemId ?? (item?.type === "command_execution" ? item.id : undefined);
  return { task, item, command, title, itemId };
}

function TaskDetails({ detail }: { readonly detail: ReturnType<typeof describeTask> }) {
  return (
    <section className="space-y-2 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-medium">{detail.title}</h3>
        <span className="shrink-0 text-xs text-muted-foreground">
          {detail.task.awaited ? "Waiting" : "Running"}
        </span>
      </div>
      {detail.command ? (
        <div className="rounded-md border border-border bg-muted/20 p-3 font-mono text-xs whitespace-pre-wrap break-words">
          <ShellCommandBlock command={detail.command} />
        </div>
      ) : null}
    </section>
  );
}

export function BackgroundWorkDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [open, setOpen] = useState(false);
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  const details = new Map(
    props.tasks.map((task) => [task.taskId, describeTask(task, props.turnItems)]),
  );
  const output = (taskId: string) => {
    const detail = details.get(taskId);
    return streamsOutput && detail?.itemId && detail.item?.status === "running" ? (
      <CommandOutputPanel
        environmentId={props.environmentId}
        threadId={detail.task.sourceThreadId ?? detail.item.threadId ?? props.threadId}
        itemId={detail.itemId}
      />
    ) : undefined;
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<InlineButton />}>Details</DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Background work</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <BackgroundWorkTaskList
            environmentId={props.environmentId}
            threadId={props.threadId}
            rows={describeSidebarBackgroundWork(props.tasks, [])}
            renderDetails={(row) => <TaskDetails detail={details.get(row.taskId)!} />}
            renderOutput={(row) => output(row.taskId)}
            renderAgent={(row) => {
              const detail = details.get(row.taskId)!;
              const childThreadId =
                detail.task.kind === "subagent" ? detail.task.childThreadId : undefined;
              return (
                <li className="space-y-2">
                  <TaskDetails detail={detail} />
                  {row.startedAt ? <BackgroundShellElapsed startedAt={row.startedAt} /> : null}
                  {output(row.taskId)}
                  {childThreadId ? (
                    <InlineButton
                      onClick={() => {
                        setOpen(false);
                        props.onOpenThread(childThreadId);
                      }}
                    >
                      Open thread
                    </InlineButton>
                  ) : null}
                </li>
              );
            }}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
