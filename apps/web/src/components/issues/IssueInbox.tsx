import { T, msg, useGT, useMessages } from "gt-react";
import { IssueHoverCard } from "./IssueHoverCard";
import { startIssueDrag } from "./issueComposerContext";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  IssueInboxEvent,
  IssueRepositoryRef,
  ScopedThreadRef,
  RepositoryIssueSummary,
} from "@t3tools/contracts";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { CheckCheckIcon, CheckIcon } from "lucide-react";
import * as Option from "effect/Option";
import type { ReactNode } from "react";
import { AsyncResult, Atom } from "effect/reactivity";

import { useServerConfigs } from "~/state/entities";
import { repositoryIssueEnvironment } from "~/state/repositoryIssues";
import { useEnvironmentQuery } from "~/state/query";
import { environmentServerConfigsAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import type { MessageResolver } from "~/i18n/messages";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useIssueSectionCollapsed } from "./useIssueSectionCollapsed";
import { useIssueQueue } from "./IssueQueueAction";
import { IssueStateIcon } from "./IssueStateIcon";

const EMPTY_COUNTS: ReadonlyMap<string, number> = new Map();

/** One subscription per environment that records the inbox; older servers are never asked. */
const unreadByRoot = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyMap<string, number> => {
    const config = get(environmentServerConfigsAtom).get(environmentId);
    if (config?.environment.capabilities.issueInbox !== true) return EMPTY_COUNTS;
    const counts = Option.getOrNull(
      AsyncResult.value(get(repositoryIssueEnvironment.inboxUnread({ environmentId, input: {} }))),
    );
    return counts === null
      ? EMPTY_COUNTS
      : new Map(counts.map((entry) => [entry.rootThreadId, entry.unread]));
  }).pipe(Atom.withLabel(`web-issues:inbox-unread:${environmentId}`)),
);

/** A row re-renders only when its own count changes. */
const threadUnread = Atom.family((key: string) =>
  Atom.make((get) => {
    const ref = parseScopedThreadKey(key);
    return ref === null ? 0 : (get(unreadByRoot(ref.environmentId)).get(ref.threadId) ?? 0);
  }).pipe(Atom.withLabel(`web-issues:inbox-thread-unread:${key}`)),
);

/** Unread external issue activity on a repository orchestrator's sidebar row. */
export function IssueInboxBadge({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const unread = useAtomValue(threadUnread(scopedThreadKey(threadRef)));
  if (unread === 0) return null;
  const label = gt(
    "{count, plural, one {{count} unread external issue event} other {{count} unread external issue events}}",
    { count: unread },
  );
  return (
    <Badge aria-label={label} size="sm" title={label} variant="info">
      {unread > 99 ? "99+" : unread}
    </Badge>
  );
}

const KIND_LABELS: Record<IssueInboxEvent["kind"], string> = {
  issue_opened: msg("Opened"),
  comment: msg("Comment"),
  closed: msg("Closed"),
  reopened: msg("Reopened"),
  labeled: msg("Labeled"),
  unlabeled: msg("Unlabeled"),
  milestoned: msg("Milestoned"),
  demilestoned: msg("Milestone removed"),
  renamed: msg("Renamed"),
  missed_activity: msg("Missed activity"),
};

function describe(event: IssueInboxEvent, resolve: MessageResolver): string {
  const kind = resolve(KIND_LABELS[event.kind]);
  const time = formatRelativeTimeLabel(event.occurredAt, undefined, resolve);
  return event.sourceProject !== null
    ? resolve(msg("{kind} from {project} · {time}", { kind, project: event.sourceProject, time }))
    : event.author !== null
      ? resolve(msg("{kind} by {author} · {time}", { kind, author: event.author, time }))
      : `${kind} · ${time}`;
}

export function useIssueInbox(environmentId: EnvironmentId, reference: IssueRepositoryRef) {
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.issueInbox === true;
  return useEnvironmentQuery(
    supported ? repositoryIssueEnvironment.inbox({ environmentId, input: reference }) : null,
  );
}

/** The repository's unread external issue activity on the Issues page, high priority first. */
export function IssueInboxSection(props: {
  readonly environmentId: EnvironmentId;
  readonly reference: IssueRepositoryRef;
  readonly issues?: readonly RepositoryIssueSummary[] | undefined;
}) {
  const supported =
    useServerConfigs().get(props.environmentId)?.environment.capabilities.issueInbox === true;
  return supported ? <InboxList {...props} /> : null;
}

function InboxList({
  environmentId,
  reference,
  issues,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: IssueRepositoryRef;
  readonly issues?: readonly RepositoryIssueSummary[] | undefined;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const { data } = useIssueInbox(environmentId, reference);
  const markRead = useAtomCommand(repositoryIssueEnvironment.markInboxRead);
  const canMark = useAtomValue(
    repositoryIssueEnvironment.markInboxRead.permissionAtom(environmentId),
  );
  const [collapsed, toggleCollapsed] = useIssueSectionCollapsed(
    { ...reference, environmentId },
    "inbox",
  );
  const events = data?.events ?? [];
  const issuesByNumber = new Map(issues?.map((issue) => [issue.number, issue]));
  const queue = useIssueQueue(environmentId, reference);
  const queuedNumbers = new Set(queue.data?.queue?.map((entry) => entry.issue.number));
  if (events.length === 0) return null;
  const mark = (ids?: ReadonlyArray<number>) =>
    void markRead({
      environmentId,
      input: { ...reference, ...(ids === undefined ? {} : { ids }) },
    });
  return (
    <section aria-label={gt("Inbox")}>
      <div className="flex items-center gap-1 pe-2">
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader
            expanded={!collapsed}
            onClick={toggleCollapsed}
            accessory={
              <span className="tabular-nums">{gt("{count} unread", { count: events.length })}</span>
            }
          >
            <T>Inbox</T>
          </CollapsibleSectionHeader>
        </div>
        {canMark ? (
          <MarkReadButton label={gt("Mark all read")} onClick={() => mark()}>
            <CheckCheckIcon />
          </MarkReadButton>
        ) : null}
      </div>
      {!collapsed ? (
        <ul>
          {events.map((event) => {
            const issue = issuesByNumber.get(event.issueNumber);
            return (
              <li key={event.id} className="px-2 py-1">
                <IssueHoverCard
                  target={{ environmentId, input: { ...reference, number: event.issueNumber } }}
                  issue={issue}
                  title={event.issueTitle}
                  render={
                    <div
                      draggable
                      onDragStart={(dragEvent) =>
                        startIssueDrag(
                          dragEvent,
                          issue ?? {
                            number: event.issueNumber,
                            title: event.issueTitle,
                            url: `https://${reference.host}/${reference.repository}/issues/${event.issueNumber}`,
                          },
                        )
                      }
                      className={cn(
                        PULL_REQUEST_ROW_CLASS,
                        "items-start px-1 py-1.5 hover:bg-accent/60",
                      )}
                    >
                      <span className="mt-0.75 flex w-4 shrink-0">
                        {issue ? (
                          <IssueStateIcon
                            issue={{ ...issue, queued: queuedNumbers.has(issue.number) }}
                          />
                        ) : null}
                      </span>
                      <a
                        className="flex min-w-0 flex-1 flex-col"
                        href={event.url}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        <PullRequestRowLines
                          number={null}
                          title={event.issueTitle}
                          signals={
                            <>
                              {event.highPriority ? (
                                <Badge size="sm" variant="warning">
                                  <T>High priority</T>
                                </Badge>
                              ) : null}
                              {event.tagged ? (
                                <Badge size="sm" variant="info">
                                  <T>Tagged</T>
                                </Badge>
                              ) : null}
                            </>
                          }
                          meta={
                            <>
                              {event.issueNumber > 0 ? (
                                <span className={PULL_REQUEST_ROW_NUMBER_CLASS}>
                                  #{event.issueNumber}
                                </span>
                              ) : null}
                              <span className="truncate">{describe(event, resolve)}</span>
                            </>
                          }
                        />
                        {event.snippet !== "" ? (
                          <span className="truncate text-2xs text-muted-foreground">
                            {event.snippet}
                          </span>
                        ) : null}
                      </a>
                      {canMark ? (
                        <MarkReadButton label={gt("Mark read")} onClick={() => mark([event.id])}>
                          <CheckIcon />
                        </MarkReadButton>
                      ) : null}
                    </div>
                  }
                />
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function MarkReadButton({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button aria-label={label} onClick={onClick} size="icon-xs" variant="ghost" />}
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
