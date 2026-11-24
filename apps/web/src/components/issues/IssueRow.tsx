import { useGT } from "gt-react";
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
  layout = "row",
}: {
  readonly issue: RepositoryIssueSummary;
  readonly environmentId?: EnvironmentId | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly className?: string;
  readonly referenceLabel?: string;
  readonly cycle?: boolean;
  readonly layout?: "row" | "card";
}) {
  const gt = useGT();
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
        layout === "card" && "flex-col items-start gap-1 px-2 py-2",
        selected ? "bg-accent" : "hover:bg-accent/60",
        className,
      )}
    >
      <button
        type="button"
        aria-label={gt("Open issue #{number}: {title}", {
          number: issue.number,
          title: issue.title,
        })}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm text-left focus-visible:outline-none",
          layout === "card" && "w-full flex-none items-start",
        )}
        onClick={onSelect}
      >
        <IssueStateIcon issue={{ ...issue, queued }} />
        <span className={PULL_REQUEST_ROW_NUMBER_CLASS}>
          {referenceLabel ?? `#${issue.number}`}
        </span>
        <span className={cn("min-w-0 text-sm", layout === "card" ? "line-clamp-2" : "truncate")}>
          {issue.title || gt("Untitled issue")}
        </span>
      </button>
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground empty:hidden",
          layout === "card" ? "max-w-full flex-wrap" : "max-w-1/2",
        )}
      >
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
