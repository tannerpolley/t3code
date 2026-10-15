import type { EnvironmentId, IssueActor, IssueSummary } from "@t3tools/contracts";
import { ListChecksIcon, MessageSquareIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import { IssuePullRequests } from "./IssuePullRequests";
import {
  PullRequestActorAvatar,
  PullRequestLabelChip,
} from "../pullRequest/pullRequestPresentation";
import { issueProjectChips } from "./issueProjects.logic";
import { IssueStateIcon } from "./IssueStateIcon";
import { IssueLiveWork } from "./IssueLiveWork";
import { issueLiveStatus } from "./issueRoadmap.logic";

/** Issue actors carry no display name; the pull request avatar and author pieces take one. */
const actor = (value: IssueActor) => ({ ...value, name: null });

/** A count with its glyph, named in full on hover. */
function RowCount({
  icon,
  count,
  label,
}: {
  readonly icon: ReactNode;
  readonly count: string;
  readonly label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex items-center gap-0.5 text-muted-foreground" />}
      >
        {icon}
        <span className="tabular-nums">{count}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** PR row primitives keep the title on its own line, with metadata and actions below. */
export function IssueRow({
  issue,
  environmentId,
  selected,
  onSelect,
  className,
  referenceLabel,
}: {
  readonly issue: IssueSummary;
  readonly environmentId?: EnvironmentId | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly className?: string;
  readonly referenceLabel?: string;
}) {
  const projectChips = issueProjectChips(issue.projects);
  const assignees = issue.assignees.slice(0, 3);
  return (
    <div
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        "min-w-0 flex-col items-stretch gap-0 py-1.5 transition-colors has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-ring",
        selected ? "bg-accent" : "hover:bg-accent/60",
        className,
      )}
    >
      <button
        type="button"
        aria-label={`Open issue #${issue.number}: ${issue.title}`}
        aria-current={selected ? "page" : undefined}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm text-left focus-visible:outline-none"
        onClick={onSelect}
      >
        <span className="mt-0.75 flex w-4 shrink-0 self-start">
          <IssueStateIcon issue={issue} />
        </span>
        <PullRequestRowLines
          number={null}
          title={issue.title || "Untitled issue"}
          metaClassName="flex-wrap overflow-visible"
          meta={
            <>
              <span className={PULL_REQUEST_ROW_NUMBER_CLASS}>
                {referenceLabel ?? `#${issue.number}`}
              </span>
              <PullRequestRowAuthor
                actor={issue.author === null ? null : actor(issue.author)}
                className="min-w-3.5 max-w-40"
              />
              {issue.labels.slice(0, 2).map((label, index) => (
                <PullRequestLabelChip key={label.name} label={label}>
                  {index === 1 && issue.labels.length > 2 ? (
                    <span className="shrink-0">+{issue.labels.length - 2}</span>
                  ) : null}
                </PullRequestLabelChip>
              ))}
              {projectChips.map((chip) => (
                <Badge key={chip.key} variant="secondary" size="sm">
                  {chip.label}
                </Badge>
              ))}
            </>
          }
          updatedAt={issue.updatedAt}
        />
      </button>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 ps-6 text-2xs text-muted-foreground">
        {issue.subIssues ? (
          <RowCount
            icon={<ListChecksIcon aria-hidden className="size-3" />}
            count={`${issue.subIssues.completed}/${issue.subIssues.total}`}
            label={`${issue.subIssues.completed} of ${issue.subIssues.total} sub-issues done`}
          />
        ) : null}
        {issue.commentCount > 0 ? (
          <RowCount
            icon={<MessageSquareIcon aria-hidden className="size-3" />}
            count={String(issue.commentCount)}
            label={`${issue.commentCount} ${issue.commentCount === 1 ? "comment" : "comments"}`}
          />
        ) : null}
        {assignees.length > 0 ? (
          <Tooltip>
            <TooltipTrigger render={<span className="flex shrink-0 -space-x-1" />}>
              {assignees.map((assignee) => (
                <PullRequestActorAvatar
                  key={assignee.login}
                  actor={actor(assignee)}
                  className="size-3.5 ring-1 ring-background"
                />
              ))}
            </TooltipTrigger>
            <TooltipPopup side="top">
              Assigned to {issue.assignees.map((assignee) => assignee.login).join(", ")}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        <IssuePullRequests
          pullRequests={issue.pullRequests}
          count={issue.pullRequestCount}
          environmentId={environmentId}
        />
        {environmentId !== undefined && issueLiveStatus(issue) !== null ? (
          <IssueLiveWork issue={issue} environmentId={environmentId} />
        ) : null}
      </div>
    </div>
  );
}
