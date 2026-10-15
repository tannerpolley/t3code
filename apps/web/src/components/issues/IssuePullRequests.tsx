import type { MouseEvent } from "react";
import type { EnvironmentId, IssuePullRequest } from "@t3tools/contracts";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { ThreadPullRequestMiniListItem } from "../ThreadStatusIndicators";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import {
  PullRequestStateGlyph,
  resolvePullRequestState,
} from "../pullRequest/pullRequestPresentation";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/** Issue rows use the PR pane's link behavior, glyphs and miniature list rows. */
export function IssuePullRequests({
  pullRequests,
  count,
  environmentId,
}: {
  pullRequests?: readonly IssuePullRequest[] | undefined;
  count?: number | undefined;
  environmentId?: EnvironmentId | undefined;
}) {
  if (pullRequests === undefined) {
    if (!count) return null;
    return (
      <span
        className="inline-flex items-center gap-0.5 text-muted-foreground"
        aria-label={`${count} linked pull requests`}
      >
        <PullRequestGlyph.pullRequest aria-hidden className="size-3" />
        <span>{count}</span>
      </span>
    );
  }
  return <DetailedIssuePullRequests pullRequests={pullRequests} environmentId={environmentId} />;
}

function DetailedIssuePullRequests({
  pullRequests,
  environmentId,
}: {
  pullRequests: readonly IssuePullRequest[];
  environmentId?: EnvironmentId | undefined;
}) {
  const openPrLink = useOpenPrLink();
  const openPr = (event: MouseEvent<HTMLElement>, url: string) =>
    openPrLink(event, url, undefined, environmentId);
  const pr = pullRequests[0];
  if (pr === undefined) return null;
  if (pullRequests.length === 1)
    return (
      <InlineButton
        tone="muted"
        render={<a href={pr.url} target="_blank" rel="noopener noreferrer" />}
        onClick={(event) => openPr(event, pr.url)}
        aria-label={`Open pull request ${pr.repository}#${pr.number}: ${pr.title}`}
      >
        {pr.state === null ? (
          <PullRequestGlyph.pullRequest aria-hidden className="size-3" />
        ) : (
          <PullRequestStateGlyph state={pr.state} isDraft={pr.isDraft} className="size-3" />
        )}
        <span>#{pr.number}</span>
      </InlineButton>
    );
  return (
    <Popover>
      <PopoverTrigger
        render={<InlineButton tone="muted" />}
        onClick={(event) => event.stopPropagation()}
        aria-label={`Show ${pullRequests.length} linked pull requests`}
      >
        <PullRequestGlyph.pullRequest aria-hidden className="size-3" />
        <span>{pullRequests.length}</span>
      </PopoverTrigger>
      <PopoverPopup width="md" padding="compact">
        <ul className="flex flex-col gap-1 text-xs" onClick={(event) => event.stopPropagation()}>
          {pullRequests.map((pr) => (
            <ThreadPullRequestMiniListItem
              key={`${pr.host}/${pr.repository}#${pr.number}`}
              number={pr.number}
              url={pr.url}
              title={pr.title || pr.repository}
              presentation={
                pr.state === null
                  ? null
                  : resolvePullRequestState({ state: pr.state, isDraft: pr.isDraft })
              }
              onOpenPullRequest={openPr}
            />
          ))}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}
