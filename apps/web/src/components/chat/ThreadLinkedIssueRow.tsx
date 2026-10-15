import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId, ThreadLinkedIssue } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { issueEnvironment, useLiveIssueSummary } from "~/state/issues";
import { IssueStateIcon } from "../issues/IssueStateIcon";
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
        <LinkedIssueStateIcon environmentId={environmentId} issue={issue} />
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

/** The issue's state the way the Issues pane shows it; open until its detail has loaded. */
function LinkedIssueStateIcon({
  environmentId,
  issue,
}: {
  readonly environmentId: EnvironmentId;
  readonly issue: ThreadLinkedIssue;
}) {
  const detail = useAtomValue(
    issueEnvironment.detail({
      environmentId,
      input: { host: issue.host, repository: issue.repository, number: issue.number },
    }),
  );
  const summary = useLiveIssueSummary(
    Option.getOrNull(AsyncResult.value(detail))?.issue,
    issue,
    environmentId,
  );
  return <IssueStateIcon issue={summary ?? { state: "open" }} className="size-4" />;
}
