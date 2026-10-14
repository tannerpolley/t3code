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
  ArrowLeftIcon,
  ExternalLinkIcon,
  GitBranchPlusIcon,
  PanelRightIcon,
  RefreshCwIcon,
} from "lucide-react";
import { issueStatePresentation } from "./IssueStateIcon";
import { useEffect, useRef, useState } from "react";

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { sanitizeNewRefName } from "../BranchToolbar.logic";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useProjects, useThreadShell } from "~/state/entities";
import { findIssueProject } from "./issueWorktree.logic";
import { agentWorktreeName } from "@t3tools/shared/git";
import {
  PullRequestActorLabel,
  PullRequestLabelChip,
  PullRequestMetaLine,
  PullRequestStateGlyph,
} from "../pullRequest/pullRequestPresentation";
import { issueSurface } from "~/rightPanelStore";
import { rememberIssueOrigin } from "./issuePullRequestOrigin";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { IssueStartAction } from "./IssueStartAction";
import { IssueChangeCards } from "./IssueChangeCards";

export interface IssueDetailPanelProps {
  readonly environmentId: EnvironmentId;
  readonly reference: IssueRef;
  readonly threadRef?: ScopedThreadRef | null;
  readonly refreshToken?: number;
  readonly onOpenBesideThread?: () => void;
  /** Back to the issue list this detail was opened from, where it is not already beside it. */
  readonly onBack?: () => void;
}

type IssueDetailTab = "summary" | "timeline";

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
  issue,
  threadRef,
}: {
  readonly pullRequests: ReadonlyArray<IssueLinkedPullRequest>;
  /** The issue showing them, which back on an opened pull request returns to. */
  readonly issue: Parameters<typeof issueSurface>[0];
  readonly threadRef: ScopedThreadRef | null;
}) {
  // Beside a thread this opens a pull request tab; without one it opens the pull requests page,
  // or the link itself when no project matches.
  const openPrLink = useOpenPrLink(threadRef ?? undefined);
  return (
    <section className="mb-5">
      <h2 className="mb-1.5 text-xs text-muted-foreground">Linked pull requests</h2>
      <ul className="flex flex-col gap-0.5">
        {pullRequests.map((pr) => {
          const url = safeExternalUrl(pr.url);
          return (
            <li key={`${pr.repository}#${pr.number}`}>
              <a
                className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-accent"
                href={url ?? undefined}
                onClick={
                  url
                    ? (event) => {
                        if (threadRef !== null)
                          rememberIssueOrigin(threadRef, pr, issueSurface(issue));
                        openPrLink(event, url);
                      }
                    : undefined
                }
                rel="noopener noreferrer"
                target="_blank"
              >
                <PullRequestStateGlyph state={pr.state} isDraft={pr.isDraft} className="size-3.5" />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {pr.repository.toLowerCase() === issue.repository.toLowerCase() ? null : (
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
    <section className="flex flex-col gap-4">
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

/**
 * Opens a draft thread for the issue's project in a new worktree on its own branch, cut from the
 * default branch when the reader sends. The task is left in the composer, unsent.
 */
function StartInWorktree({
  environmentId,
  host,
  repository,
  issue,
  threadRef,
}: {
  readonly environmentId: EnvironmentId;
  readonly host: string;
  readonly repository: string;
  readonly issue: { readonly number: number; readonly title: string; readonly url: string };
  readonly threadRef: ScopedThreadRef | null;
}) {
  const projects = useProjects();
  const threadShell = useThreadShell(threadRef);
  const handleNewThread = useNewThreadHandler();
  const [branch, setBranch] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const project = findIssueProject(
    projects,
    { environmentId, host, repository },
    threadShell?.projectId ?? null,
  );
  if (project === null) return null;
  if (branch === null) {
    return (
      <Button
        onClick={() => setBranch(agentWorktreeName(issue.title, issue.number))}
        size="xs"
        variant="outline"
      >
        <GitBranchPlusIcon aria-hidden />
        Prepare draft
      </Button>
    );
  }
  const refName = sanitizeNewRefName(branch);
  const start = async () => {
    setStarting(true);
    const opened = await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
      envMode: "worktree",
      branch: null,
      worktreePath: null,
      worktreeBranch: refName,
    }).catch(() => null);
    setStarting(false);
    if (opened === null) {
      toastManager.add({ type: "error", title: "Could not open a thread" });
      return;
    }
    const title = issue.title || "Untitled issue";
    useComposerDraftStore
      .getState()
      .setPrompt(opened.draftId, `Work on #${issue.number}: ${title}\n\n${issue.url}`);
    setBranch(null);
  };
  return (
    <form
      className="flex min-w-64 items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (refName.length > 0 && !starting) void start();
      }}
    >
      <Input
        aria-label="New branch name"
        autoFocus
        className="flex-1"
        onChange={(event) => setBranch(event.target.value)}
        size="compact"
        value={branch}
      />
      <Button disabled={refName.length === 0 || starting} size="xs" type="submit">
        Create
      </Button>
      <Button onClick={() => setBranch(null)} size="xs" type="button" variant="ghost">
        Cancel
      </Button>
    </form>
  );
}

export function IssueDetailPanel({
  environmentId,
  reference,
  threadRef = null,
  refreshToken,
  onOpenBesideThread,
  onBack,
}: IssueDetailPanelProps) {
  const atom = issueEnvironment.detail({ environmentId, input: reference });
  // The tab belongs to one issue; the panel is reused as another opens, which starts on Summary.
  const issueKey = `${reference.host}/${reference.repository}#${reference.number}`;
  const [tabChoice, setTabChoice] = useState<{ key: string; tab: IssueDetailTab } | null>(null);
  const tab = tabChoice?.key === issueKey ? tabChoice.tab : "summary";
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
        <p className="text-xs text-muted-foreground" role="status">
          Loading issue…
        </p>
      </div>
    );
  }

  const { issue, body, repository, comments, linkedPullRequests } = query.data;
  const issueUrl = safeExternalUrl(issue.url);
  const canOpenBesideThread = threadRef !== null && onOpenBesideThread !== undefined;
  const state = issueStatePresentation(issue);
  const tabs: ReadonlyArray<{ value: IssueDetailTab; label: string }> = [
    { value: "summary", label: "Summary" },
    {
      value: "timeline",
      label: issue.commentCount > 0 ? `Timeline · ${issue.commentCount}` : "Timeline",
    },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {/* The pull request detail's header: back, `repository #n ↗` in the state's tone, title,
          then the state, author and update time. */}
      <header className="shrink-0 border-b border-border/60">
        <div className="flex h-7 min-w-0 items-center gap-1 px-4 pt-1 text-xs text-muted-foreground">
          {onBack ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Back to issues"
                    className="-ml-1.5"
                    onClick={onBack}
                    size="icon-micro"
                    variant="ghost-muted"
                  >
                    <ArrowLeftIcon aria-hidden className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Back to issues</TooltipPopup>
            </Tooltip>
          ) : null}
          <span className="min-w-0 truncate font-medium">{repository.repository}</span>
          {issueUrl ? (
            <a
              aria-label={`Open issue #${issue.number} on GitHub`}
              className={cn(
                "inline-flex shrink-0 items-center gap-0.5 font-medium underline-offset-2 hover:underline",
                state.toneClassName,
              )}
              href={issueUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              #{issue.number}
              <ExternalLinkIcon aria-hidden className="size-2.5" />
            </a>
          ) : (
            <span className={cn("shrink-0 font-medium", state.toneClassName)}>#{issue.number}</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {canOpenBesideThread ? (
              <Button onClick={onOpenBesideThread} size="xs" variant="outline">
                <PanelRightIcon aria-hidden />
                Open beside thread
              </Button>
            ) : null}
            <Button
              aria-label="Refresh issue"
              disabled={query.isPending}
              onClick={query.refresh}
              size="icon-xs"
              variant="ghost"
            >
              <RefreshCwIcon aria-hidden />
            </Button>
          </span>
        </div>
        <div className="min-w-0 px-4 pb-3">
          <h1 className="mt-1 text-base font-semibold leading-snug text-foreground">
            {issue.title || "Untitled issue"}
          </h1>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge size="sm" variant={state.badgeVariant}>
              <state.Icon aria-hidden className={state.toneClassName} />
              {state.label}
            </Badge>
            <PullRequestMetaLine className="min-w-0 whitespace-nowrap">
              <PullRequestActorLabel
                actor={issue.author === null ? null : { ...issue.author, name: null }}
              />
              <span>updated {formatRelativeTimeLabel(issue.updatedAt)}</span>
            </PullRequestMetaLine>
            <div className="ml-auto flex flex-wrap items-start gap-1.5">
              <IssueStartAction
                key={`${environmentId}:${repository.host}:${repository.repository}:${issue.number}`}
                environmentId={environmentId}
                reference={{ ...repository, number: issue.number }}
                threadRef={threadRef}
                closed={issue.state === "closed"}
              />
              <StartInWorktree
                environmentId={environmentId}
                host={repository.host}
                repository={repository.repository}
                issue={issue}
                threadRef={threadRef}
              />
            </div>
          </div>
        </div>
        <nav aria-label="Issue tabs" className="border-t border-border/60 px-4 py-2">
          <ToggleGroup
            size="segmented"
            variant="segmented"
            value={[tab]}
            onValueChange={(next) => {
              const chosen = tabs.find((item) => item.value === next[0])?.value;
              if (chosen) setTabChoice({ key: issueKey, tab: chosen });
            }}
          >
            {tabs.map((item) => (
              <Toggle key={item.value} value={item.value}>
                {item.label}
              </Toggle>
            ))}
          </ToggleGroup>
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <IssueChangeCards environmentId={environmentId} input={reference} />
        {staleError ? (
          <div
            className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs"
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
        {tab === "timeline" ? (
          issue.commentCount > 0 ? (
            <IssueComments
              comments={comments}
              environmentId={environmentId}
              issueUrl={issueUrl}
              threadRef={threadRef}
              totalCount={issue.commentCount}
            />
          ) : (
            <p className="text-sm italic text-muted-foreground">No comments yet.</p>
          )
        ) : (
          <>
            <dl className="mb-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
              <dt className="text-muted-foreground">Assignees</dt>
              <dd className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-foreground">
                {issue.assignees.length > 0
                  ? issue.assignees.map((assignee) => (
                      <PullRequestActorLabel
                        key={assignee.login}
                        actor={{ ...assignee, name: null }}
                      />
                    ))
                  : "Unassigned"}
              </dd>
              <dt className="text-muted-foreground">Milestone</dt>
              <dd className="truncate text-foreground">
                {issue.milestone?.title ?? "No Milestone"}
              </dd>
              <dt className="text-muted-foreground">Labels</dt>
              <dd className="flex min-w-0 flex-wrap gap-1">
                {issue.labels.length > 0
                  ? issue.labels.map((label) => (
                      <PullRequestLabelChip key={label.name} label={label} />
                    ))
                  : "None"}
              </dd>
            </dl>
            {linkedPullRequests.length > 0 ? (
              <LinkedPullRequests
                issue={{ environmentId, ...repository, number: issue.number }}
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
          </>
        )}
        {query.isPending ? (
          <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            Refreshing issue…
          </p>
        ) : null}
      </div>
    </div>
  );
}
