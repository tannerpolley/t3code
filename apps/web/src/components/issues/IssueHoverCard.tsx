import { T, useGT, Var } from "gt-react";
import { RelativeTime } from "~/components/RelativeTime";
import { issueWorkerStatus } from "@t3tools/shared/issueWorkerStatus";
import { useWorkerStatusLabels } from "./IssueLiveWork";
import type { EnvironmentId, RepositoryIssueRef, RepositoryIssueSummary } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";

import { useOpenIssueLink } from "~/lib/openIssueLink";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { repositoryIssueEnvironment, useLiveIssueSummary } from "~/state/repositoryIssues";
import { useEnvironmentQuery } from "~/state/query";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ThreadPullRequestsMiniList } from "../ThreadStatusIndicators";
import { PullRequestLabelChip } from "../pullRequest/pullRequestPresentation";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { useIssueQueued } from "./IssueQueueAction";
import { IssueStateIcon, issueStatePresentation, useIssueStateLabel } from "./IssueStateIcon";
import { issueHoverPullRequests } from "./issueHoverCard.logic";
import { openIssueBlockers } from "./issueRoadmap.logic";

export interface IssueHoverTarget {
  readonly environmentId: EnvironmentId;
  readonly input: RepositoryIssueRef;
}

interface IssueHoverContentProps {
  readonly target: IssueHoverTarget;
  readonly issue?: RepositoryIssueSummary | undefined;
  readonly title?: string | undefined;
}

/** Mounted only in an open hover: the detail cache and streamed shell overlay stay shared. */
function IssueHoverCardContent({ target, issue: fallback, title }: IssueHoverContentProps) {
  const gt = useGT();
  const { environmentId, input } = target;
  const labels = useWorkerStatusLabels();
  const query = useEnvironmentQuery(repositoryIssueEnvironment.detail({ environmentId, input }));
  const issue = useLiveIssueSummary(query.data?.issue ?? fallback, input, environmentId);
  const queued = useIssueQueued(environmentId, input);
  const label = useIssueStateLabel(
    issue === undefined ? "" : issueStatePresentation({ ...issue, queued }).label,
  );
  const openPr = useOpenPrLink();
  const openIssue = useOpenIssueLink();
  const pullRequests =
    issue === undefined ? [] : issueHoverPullRequests(issue, input.host, query.data);
  const blockers = issue === undefined ? [] : openIssueBlockers(issue);
  return (
    <ThreadHoverCard
      title={issue?.title || title || `${input.repository} #${input.number}`}
      footer={
        pullRequests.length > 0 ? (
          <div className="border-t border-border/60 pt-2 pl-0.5 text-xs text-muted-foreground">
            <ThreadPullRequestsMiniList
              pullRequests={pullRequests}
              onOpenPullRequest={(event, url) => openPr(event, url, undefined, environmentId)}
            />
          </div>
        ) : null
      }
    >
      <div>
        {input.repository} #{input.number}
      </div>
      {issue === undefined ? (
        <div>{query.error === null ? gt("Loading issue…") : gt("Issue details unavailable")}</div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <IssueStateIcon issue={{ ...issue, queued }} />
            <span>{label}</span>
          </div>
          <div>
            {gt("Opened by {author}", { author: issue.author?.login ?? "ghost" })}
            {issue.commentCount > 0
              ? ` · ${gt("{count, plural, one {# comment} other {# comments}}", { count: issue.commentCount })}`
              : ""}
            {" · "}
            <T>
              updated <Var>{<RelativeTime timestamp={issue.updatedAt} />}</Var>
            </T>
          </div>
          {issue.labels.length > 0 ? (
            <div className="flex flex-wrap gap-1" aria-label={gt("Labels")}>
              {issue.labels.map((label) => (
                <PullRequestLabelChip key={label.name} label={label} />
              ))}
            </div>
          ) : null}
          {issue.assignees.length > 0 ? (
            <div>
              {gt("Assigned to {assignees}", {
                assignees: issue.assignees.map((assignee) => assignee.login).join(", "),
              })}
            </div>
          ) : null}
          {blockers.length > 0 ? (
            <div className="grid gap-1">
              <span>
                {gt(
                  "{count, plural, one {Blocked by # open issue} other {Blocked by # open issues}}",
                  {
                    count: blockers.length,
                  },
                )}
              </span>
              {blockers.map((blocker) => {
                const url = `https://${blocker.host}/${blocker.repository}/issues/${blocker.number}`;
                return (
                  <a
                    key={url}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                    onClick={(event) => openIssue(event, url, environmentId)}
                  >
                    {blocker.repository} #{blocker.number}
                  </a>
                );
              })}
            </div>
          ) : null}
          {issue.blockedBy === undefined || issue.relationshipsComplete === false ? (
            <div>
              <T>Blocker information incomplete</T>
            </div>
          ) : null}
          {issue.subIssues && issue.subIssues.total > 0 ? (
            <div>
              {gt("Sub-issues: {completed} / {total} completed", {
                completed: issue.subIssues.completed,
                total: issue.subIssues.total,
              })}
            </div>
          ) : null}
          {(issue.liveWork?.length ?? 0) > 0 ? (
            <div className="grid gap-1">
              <span>
                <T>Linked agents</T>
              </span>
              {issue.liveWork?.map((work) => (
                <Link
                  key={work.threadId}
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: work.threadId }}
                  className="wrap-anywhere hover:underline"
                >
                  {work.title} · {labels[issueWorkerStatus(work, issue)]}
                </Link>
              ))}
            </div>
          ) : null}
          {query.error !== null ? (
            <div>
              <T>Issue details unavailable; showing cached information</T>
            </div>
          ) : null}
        </>
      )}
    </ThreadHoverCard>
  );
}

export function IssueHoverCard({
  render,
  ...props
}: IssueHoverContentProps & { readonly render: ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger render={render} delay={350} closeDelay={120} />
      <ThreadHoverCardPopup
        side="right"
        align="start"
        sideOffset={4}
        className="pointer-events-auto"
      >
        {open ? <IssueHoverCardContent {...props} /> : null}
      </ThreadHoverCardPopup>
    </Tooltip>
  );
}
