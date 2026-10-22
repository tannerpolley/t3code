import type {
  EnvironmentId,
  ThreadId,
  OrchestrationV2PendingBackgroundTask,
} from "@t3tools/contracts";
import { useState } from "react";
import { BackgroundWorkTaskList } from "./BackgroundWorkTaskList";
import { describeSidebarBackgroundWork } from "../sidebar/SidebarBackgroundWork.logic";

export function BackgroundWorkDetails(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        Background tasks {expanded ? "▾" : "▸"}
      </button>
      {expanded ? (
        <BackgroundWorkTaskList
          environmentId={props.environmentId}
          threadId={props.threadId}
          rows={describeSidebarBackgroundWork(props.tasks, [])}
        />
      ) : null}
    </div>
  );
}
