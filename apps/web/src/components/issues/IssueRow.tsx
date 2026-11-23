import { IssueHoverCard } from "./IssueHoverCard";
import { useIssueQueued } from "./IssueQueueAction";
import { parseIssueUrl, knownIssueHosts } from "~/lib/openRepositoryIssueLink";
import { useProjects } from "~/state/entities";
import { startIssueDrag } from "./issueComposerContext";
import type { EnvironmentId, RepositoryIssueSummary } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
} from "../pullRequest/PullRequestListRow";
import { IssuePullRequests } from "./IssuePullRequests";
import { IssueStageBadges, IssueStateIcon } from "./IssueStateIcon";
import { IssueLiveWork } from "./IssueLiveWork";
import { issueLiveStatus } from "./issueRoadmap.logic";

/** One line: number, title, stage badges, pull requests and live worker; the rest is on hover. */
export function IssueRow({
  issue,
  environmentId,
  selected,
  onSelect,
  className,
  referenceLabel,
  cycle,
}: {
  readonly issue: RepositoryIssueSummary;
  readonly environmentId?: EnvironmentId | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly className?: string;
  readonly referenceLabel?: string;
  readonly cycle?: boolean;
}) {
  const projects = useProjects();
  const reference = parseIssueUrl(issue.url, knownIssueHosts(projects));
  const queued = useIssueQueued(environmentId, reference);
  const liveStatus = environmentId === undefined ? null : issueLiveStatus(issue);
  const row = (
    <div
      draggable
      onDragStart={(event) => startIssueDrag(event, issue)}
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        "min-w-0 transition-colors has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-ring",
        selected ? "bg-accent" : "hover:bg-accent/60",
        className,
      )}
    >
      <button
        type="button"
        aria-label={`Open issue #${issue.number}: ${issue.title}`}
        aria-current={selected ? "page" : undefined}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm text-left focus-visible:outline-none"
        onClick={onSelect}
      >
        <IssueStateIcon issue={{ ...issue, queued }} />
        <span className={PULL_REQUEST_ROW_NUMBER_CLASS}>
          {referenceLabel ?? `#${issue.number}`}
        </span>
        <span className="min-w-0 truncate text-sm">{issue.title || "Untitled issue"}</span>
      </button>
      <span className="flex min-w-0 max-w-1/2 items-center gap-1.5 text-2xs text-muted-foreground">
        <IssueStageBadges issue={issue} cycle={cycle} liveStatus={liveStatus} />
        <IssuePullRequests
          pullRequests={issue.pullRequests}
          count={issue.pullRequestCount}
          environmentId={environmentId}
        />
        {environmentId !== undefined && liveStatus !== null ? (
          <IssueLiveWork issue={issue} environmentId={environmentId} />
        ) : null}
      </span>
    </div>
  );
  return environmentId !== undefined && reference !== null ? (
    <IssueHoverCard render={row} target={{ environmentId, input: reference }} issue={issue} />
  ) : (
    row
  );
}
