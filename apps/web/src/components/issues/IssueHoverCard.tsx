import type { EnvironmentId, IssueRef, IssueSummary } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";

import { useOpenIssueLink } from "~/lib/openIssueLink";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { issueEnvironment, useLiveIssueSummary } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ThreadPullRequestsMiniList } from "../ThreadStatusIndicators";
import { PullRequestLabelChip } from "../pullRequest/pullRequestPresentation";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { useIssueQueued } from "./IssueQueueAction";
import { IssueStateIcon, issueStatePresentation } from "./IssueStateIcon";
import { issueHoverPullRequests } from "./issueHoverCard.logic";
import { openIssueBlockers } from "./issueRoadmap.logic";

export interface IssueHoverTarget {
  readonly environmentId: EnvironmentId;
  readonly input: IssueRef;
}

interface IssueHoverContentProps {
  readonly target: IssueHoverTarget;
  readonly issue?: IssueSummary | undefined;
  readonly title?: string | undefined;
}

/** Mounted only in an open hover: the detail cache and streamed shell overlay stay shared. */
export function IssueHoverCardContent({ target, issue: fallback, title }: IssueHoverContentProps) {
  const { environmentId, input } = target;
  const query = useEnvironmentQuery(issueEnvironment.detail({ environmentId, input }));
  const issue = useLiveIssueSummary(query.data?.issue ?? fallback, input, environmentId);
  const queued = useIssueQueued(environmentId, input);
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
        <div>{query.error === null ? "Loading issue…" : "Issue details unavailable"}</div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <IssueStateIcon issue={{ ...issue, queued }} />
            <span>{issueStatePresentation({ ...issue, queued }).label}</span>
          </div>
          {issue.milestone ? <div>Milestone: {issue.milestone.title}</div> : null}
          {issue.labels.length > 0 ? (
            <div className="flex flex-wrap gap-1" aria-label="Labels">
              {issue.labels.map((label) => (
                <PullRequestLabelChip key={label.name} label={label} />
              ))}
            </div>
          ) : null}
          {issue.assignees.length > 0 ? (
            <div>Assigned to {issue.assignees.map((assignee) => assignee.login).join(", ")}</div>
          ) : null}
          {blockers.length > 0 ? (
            <div className="grid gap-1">
              <span>
                Blocked by {blockers.length} open {blockers.length === 1 ? "issue" : "issues"}
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
            <div>Blocker information incomplete</div>
          ) : null}
          {issue.subIssues && issue.subIssues.total > 0 ? (
            <div>
              Sub-issues: {issue.subIssues.completed} / {issue.subIssues.total} completed
            </div>
          ) : null}
          {(issue.liveWork?.length ?? 0) > 0 ? (
            <div className="grid gap-1">
              <span>Linked agents</span>
              {issue.liveWork?.map((work) => (
                <Link
                  key={work.threadId}
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: work.threadId }}
                  className="wrap-anywhere hover:underline"
                >
                  {work.title} ·{" "}
                  {work.status === "working"
                    ? "Working"
                    : work.status === "waiting_on_you"
                      ? "Waiting on you"
                      : "Idle"}
                </Link>
              ))}
            </div>
          ) : null}
          {query.error !== null ? (
            <div>Issue details unavailable; showing cached information</div>
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
