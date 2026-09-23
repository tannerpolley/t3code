import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import type {
  EnvironmentId,
  IssueComment,
  IssueLinkedPullRequest,
  IssueRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  EnvironmentAuthorizationError as EnvironmentAuthorizationErrorClass,
  IssueReadError as IssueReadErrorClass,
} from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  CircleDotIcon,
  ExternalLinkIcon,
  MessageSquareIcon,
  PanelRightIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";

import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";

export interface IssueDetailPanelProps {
  readonly environmentId: EnvironmentId;
  readonly reference: IssueRef;
  readonly threadRef?: ScopedThreadRef | null;
  readonly refreshToken?: number;
  readonly onOpenBesideThread?: () => void;
}

type IssuePanelError = {
  readonly title: string;
  readonly description: string;
  readonly retryAt?: number;
};

const isIssueReadError = Schema.is(IssueReadErrorClass);
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationErrorClass);
const isEnvironmentRpcUnavailableError = Schema.is(EnvironmentRpcUnavailableError);

function issuePanelError(cause: Cause.Cause<unknown>, fallback: string | null): IssuePanelError {
  const error = Cause.squash(cause);
  if (isIssueReadError(error)) {
    switch (error.code) {
      case "unauthenticated":
        return { title: "GitHub authentication required", description: error.message };
      case "verification-unavailable":
        return { title: "GitHub sign-in could not be verified", description: error.message };
      case "rate-limited":
        return {
          title: "GitHub rate limit reached",
          description: error.message,
          ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
        };
      case "scope-unavailable":
        return { title: "Project scope unavailable", description: error.message };
      case "unsupported":
      case "missing-tool":
        return { title: "GitHub issues unavailable", description: error.message };
      case "inaccessible":
        return { title: "Issue unavailable", description: error.message };
      case "invalid-cursor":
      case "invalid-response":
        return { title: "GitHub returned an invalid issue response", description: error.message };
      case "upstream":
        return { title: "GitHub could not load this issue", description: error.message };
    }
  }
  if (isEnvironmentAuthorizationError(error)) {
    return { title: "Environment authorization required", description: error.message };
  }
  if (isEnvironmentRpcUnavailableError(error)) {
    return { title: "Environment offline", description: "Reconnect this environment and retry." };
  }
  return {
    title: "Could not load issue",
    description: fallback ?? "The issue request failed. Retry to try again.",
  };
}

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function actorLabel(actor: { readonly login: string } | null): string {
  return actor === null ? "Unknown" : `@${actor.login}`;
}

function retryDeadline(retryAt: number): string {
  const date = new Date(retryAt);
  return Number.isNaN(date.getTime()) ? String(retryAt) : date.toLocaleString();
}

function LinkedPullRequests({
  pullRequests,
  issueRepository,
  threadRef,
}: {
  readonly pullRequests: ReadonlyArray<IssueLinkedPullRequest>;
  readonly issueRepository: string;
  readonly threadRef: ScopedThreadRef | null;
}) {
  // Without a thread this opens the pull requests page, or the link itself when no project matches.
  const openPrLink = useOpenPrLink(threadRef ?? undefined);
  return (
    <section className="mb-5">
      <h2 className="mb-1.5 text-xs text-muted-foreground">Linked pull requests</h2>
      <ul className="flex flex-col gap-0.5">
        {pullRequests.map((pr) => {
          const url = safeExternalUrl(pr.url);
          const presentation =
            PULL_REQUEST_STATE_PRESENTATION[pr.state === "open" && pr.isDraft ? "draft" : pr.state];
          return (
            <li key={`${pr.repository}#${pr.number}`}>
              <a
                className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-accent"
                href={url ?? undefined}
                onClick={url ? (event) => openPrLink(event, url) : undefined}
                rel="noopener noreferrer"
                target="_blank"
              >
                <presentation.Icon
                  aria-label={presentation.label}
                  className={cn("size-3.5 shrink-0", presentation.toneClassName)}
                />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {pr.repository.toLowerCase() === issueRepository.toLowerCase() ? null : (
                    <span className="font-mono text-muted-foreground">{pr.repository} </span>
                  )}
                  <span className="text-muted-foreground">#{pr.number}</span> {pr.title}
                </span>
                {pr.closesIssue ? (
                  <Badge className="shrink-0" size="sm" variant="outline">
                    closes
                  </Badge>
                ) : null}
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function IssueComments({
  comments,
  totalCount,
  issueUrl,
  environmentId,
  threadRef,
}: {
  readonly comments: ReadonlyArray<IssueComment>;
  readonly totalCount: number;
  readonly issueUrl: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const hidden = totalCount - comments.length;
  return (
    <section className="mt-5 flex flex-col gap-4 border-t border-border/50 pt-4">
      {hidden > 0 ? (
        <p className="text-xs text-muted-foreground">
          {hidden} earlier {hidden === 1 ? "comment" : "comments"} not shown
          {issueUrl ? (
            <>
              {" · "}
              <a
                className="underline-offset-2 hover:text-foreground hover:underline"
                href={issueUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                Open on GitHub
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {comments.map((comment) => (
        <article key={comment.url} className="min-w-0">
          <p className="mb-1.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{actorLabel(comment.author)}</span>{" "}
            commented {formatRelativeTimeLabel(comment.createdAt)}
          </p>
          {comment.body.trim().length > 0 ? (
            <ChatMarkdown
              cwd={undefined}
              environmentId={environmentId}
              threadRef={threadRef ?? undefined}
              text={comment.body}
            />
          ) : (
            <p className="text-sm italic text-muted-foreground">No content.</p>
          )}
        </article>
      ))}
    </section>
  );
}

export function IssueDetailPanel({
  environmentId,
  reference,
  threadRef = null,
  refreshToken,
  onOpenBesideThread,
}: IssueDetailPanelProps) {
  const atom = issueEnvironment.detail({ environmentId, input: reference });
  const result = useAtomValue(atom);
  const query = useEnvironmentQuery(atom);
  const lastRefreshToken = useRef(refreshToken);
  const staleError =
    query.data !== null && result._tag === "Failure"
      ? issuePanelError(result.cause, query.error)
      : null;

  useEffect(() => {
    if (
      refreshToken !== undefined &&
      lastRefreshToken.current !== undefined &&
      refreshToken !== lastRefreshToken.current
    ) {
      query.refresh();
    }
    lastRefreshToken.current = refreshToken;
  }, [query.refresh, refreshToken]);

  if (query.data === null && result._tag === "Failure") {
    const error = issuePanelError(result.cause, query.error);
    return (
      <Empty className="min-h-64">
        <EmptyHeader>
          <EmptyTitle>{error.title}</EmptyTitle>
          <EmptyDescription>{error.description}</EmptyDescription>
          {error.retryAt !== undefined ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Retry after {retryDeadline(error.retryAt)}.
            </p>
          ) : null}
        </EmptyHeader>
        <Button onClick={query.refresh} size="sm" variant="outline">
          <RefreshCwIcon aria-hidden />
          Retry
        </Button>
      </Empty>
    );
  }

  if (query.data === null) {
    return (
      <div className="flex min-h-64 flex-1 items-center justify-center" aria-label="Loading issue">
        <Spinner className="size-4" />
      </div>
    );
  }

  const { issue, body, repository, comments, linkedPullRequests } = query.data;
  const issueUrl = safeExternalUrl(issue.url);
  const canOpenBesideThread = threadRef !== null && onOpenBesideThread !== undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="shrink-0 border-b border-border/60 px-4 py-3">
        <div className="flex items-start gap-3">
          {issue.state === "closed" ? (
            <CheckCircle2Icon aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground" />
          ) : (
            <CircleDotIcon aria-hidden className="mt-1 size-4 shrink-0 text-emerald-500" />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs text-muted-foreground">
              {repository.repository} #{issue.number}
            </p>
            <h1 className="mt-1 text-base font-semibold leading-snug text-foreground">
              {issue.title || "Untitled issue"}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge size="sm" variant={issue.state === "open" ? "success" : "secondary"}>
                {issue.state}
              </Badge>
              {issue.stateReason ? (
                <span className="text-xs text-muted-foreground">{issue.stateReason}</span>
              ) : null}
              <Button
                aria-label="Refresh issue"
                className="ml-auto"
                disabled={query.isPending}
                onClick={query.refresh}
                size="icon-xs"
                variant="ghost"
              >
                <RefreshCwIcon aria-hidden className={cn(query.isPending && "animate-spin")} />
              </Button>
              {issueUrl ? (
                <a
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  href={issueUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Open on GitHub
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </a>
              ) : null}
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>Opened by {actorLabel(issue.author)}</span>
          <span>updated {formatRelativeTimeLabel(issue.updatedAt)}</span>
          <span className="inline-flex items-center gap-1">
            <MessageSquareIcon aria-hidden className="size-3" />
            {issue.commentCount} {issue.commentCount === 1 ? "comment" : "comments"}
          </span>
          {canOpenBesideThread ? (
            <Button className="ml-auto" onClick={onOpenBesideThread} size="xs" variant="outline">
              <PanelRightIcon aria-hidden />
              Open beside thread
            </Button>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {staleError ? (
          <div
            className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs"
            role="status"
          >
            <div className="min-w-0">
              <p className="font-medium text-foreground">
                {staleError.title}. Showing the last issue loaded.
              </p>
              <p className="mt-1 text-muted-foreground">{staleError.description}</p>
              {staleError.retryAt !== undefined ? (
                <p className="mt-1 text-muted-foreground">
                  Retry after {retryDeadline(staleError.retryAt)}.
                </p>
              ) : null}
            </div>
            <Button onClick={query.refresh} size="xs" variant="outline">
              Retry
            </Button>
          </div>
        ) : null}
        <dl className="mb-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
          <dt className="text-muted-foreground">Assignees</dt>
          <dd className="truncate text-foreground">
            {issue.assignees.length > 0
              ? issue.assignees.map((assignee) => `@${assignee.login}`).join(", ")
              : "Unassigned"}
          </dd>
          <dt className="text-muted-foreground">Milestone</dt>
          <dd className="truncate text-foreground">{issue.milestone?.title ?? "No Milestone"}</dd>
          <dt className="text-muted-foreground">Labels</dt>
          <dd className="flex min-w-0 flex-wrap gap-1">
            {issue.labels.length > 0
              ? issue.labels.map((label) => (
                  <Badge
                    key={label.name}
                    className="gap-1 border-border/60 text-muted-foreground"
                    size="sm"
                    variant="outline"
                  >
                    {label.color ? (
                      <span
                        aria-hidden
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: `#${label.color}` }}
                      />
                    ) : null}
                    {label.name}
                  </Badge>
                ))
              : "None"}
          </dd>
        </dl>
        {linkedPullRequests.length > 0 ? (
          <LinkedPullRequests
            issueRepository={repository.repository}
            pullRequests={linkedPullRequests}
            threadRef={threadRef}
          />
        ) : null}
        <div className="border-t border-border/50 pt-4">
          {body.trim().length > 0 ? (
            <ChatMarkdown
              cwd={undefined}
              environmentId={environmentId}
              threadRef={threadRef ?? undefined}
              text={body}
            />
          ) : (
            <p className="text-sm italic text-muted-foreground">No description.</p>
          )}
        </div>
        {issue.commentCount > 0 ? (
          <IssueComments
            comments={comments}
            environmentId={environmentId}
            issueUrl={issueUrl}
            threadRef={threadRef}
            totalCount={issue.commentCount}
          />
        ) : null}
        {query.isPending ? (
          <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3" /> Refreshing issue…
          </p>
        ) : null}
      </div>
    </div>
  );
}
