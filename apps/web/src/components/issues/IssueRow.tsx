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

/**
 * An issue list row in the pull request row's shape: the state glyph, then `#n title` with
 * sub-issue progress, closing pull requests, comments and assignees on the right, and a meta line
 * of author, labels and Project fields with the update time on the right. The caller places it.
 */
export function IssueRow({
  issue,
  environmentId,
  selected,
  onSelect,
  className,
}: {
  readonly issue: IssueSummary;
  readonly environmentId?: EnvironmentId | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly className?: string;
}) {
  const projectChips = issueProjectChips(issue.projects);
  const assignees = issue.assignees.slice(0, 3);
  return (
    <div
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        "min-w-0 py-1.5 transition-colors has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-ring",
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
        <span className="mt-0.75 flex w-4 shrink-0 self-start">
          <IssueStateIcon issue={issue} />
        </span>
        <PullRequestRowLines
          number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>#{issue.number}</span>}
          title={issue.title || "Untitled issue"}
          status={
            <>
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
            </>
          }
          meta={
            <>
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
      <span className="mt-0.75 shrink-0 self-start">
        <IssuePullRequests pullRequests={issue.pullRequests ?? []} environmentId={environmentId} />
      </span>
    </div>
  );
}
