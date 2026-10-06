import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { CircleDotIcon } from "lucide-react";

import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

/** The durable issue link remains reachable even when repository browsing is hidden or unavailable. */
export function ThreadLinkedIssueRow({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = scopeThreadRef(environmentId, threadId);
  const issue = useThreadShell(threadRef)?.linkedIssue;
  if (!issue) return null;
  return (
    <ThreadDetailsSection headingId="thread-details-linked-issue-heading" title="Linked issue">
      <ThreadDetailsControl
        onClick={() =>
          useRightPanelStore.getState().openIssue(threadRef, { environmentId, ...issue })
        }
      >
        <CircleDotIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">
          <span className="me-1 text-muted-foreground">
            {issue.repository} #{issue.number}
          </span>
          {issue.title || "Untitled issue"}
        </span>
      </ThreadDetailsControl>
    </ThreadDetailsSection>
  );
}
