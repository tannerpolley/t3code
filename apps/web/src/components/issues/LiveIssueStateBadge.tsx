import type { EnvironmentId, IssueRepositoryRef, IssueSummary } from "@t3tools/contracts";

import { useLiveIssueSummary } from "~/state/issues";
import { useIssueQueued } from "./IssueQueueAction";
import { IssueStateIcon, issueStatePresentation } from "./IssueStateIcon";
import { Badge } from "../ui/badge";

/** Detail headers use the same streamed state as list rows, without another issue query. */
export function LiveIssueStateBadge({
  issue,
  reference,
  environmentId,
}: {
  readonly issue: IssueSummary;
  readonly reference: IssueRepositoryRef;
  readonly environmentId: EnvironmentId;
}) {
  const liveIssue = useLiveIssueSummary(issue, reference, environmentId);
  const queued = useIssueQueued(environmentId, { ...reference, number: issue.number });
  const summary = { ...(liveIssue ?? issue), queued };
  const state = issueStatePresentation(summary);
  return (
    <Badge size="sm" variant={state.badgeVariant}>
      <IssueStateIcon issue={summary} className="size-3.5" />
      {state.label}
    </Badge>
  );
}
