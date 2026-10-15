import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  IssueInboxEvent,
  IssueRepositoryRef,
  ScopedThreadRef,
  IssueSummary,
} from "@t3tools/contracts";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { useServerConfigs } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { environmentServerConfigsAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { IssueStateIcon } from "./IssueStateIcon";

const EMPTY_COUNTS: ReadonlyMap<string, number> = new Map();

/** One subscription per environment that records the inbox; older servers are never asked. */
const unreadByRoot = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyMap<string, number> => {
    const config = get(environmentServerConfigsAtom).get(environmentId);
    if (config?.environment.capabilities.issueInbox !== true) return EMPTY_COUNTS;
    const counts = Option.getOrNull(
      AsyncResult.value(get(issueEnvironment.inboxUnread({ environmentId, input: {} }))),
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
  const unread = useAtomValue(threadUnread(scopedThreadKey(threadRef)));
  if (unread === 0) return null;
  const label = `${unread} unread external issue event${unread === 1 ? "" : "s"}`;
  return (
    <Badge aria-label={label} size="sm" title={label} variant="info">
      {unread > 99 ? "99+" : unread}
    </Badge>
  );
}

const KIND_LABELS: Record<IssueInboxEvent["kind"], string> = {
  issue_opened: "Opened",
  comment: "Comment",
  closed: "Closed",
  reopened: "Reopened",
  labeled: "Labeled",
  unlabeled: "Unlabeled",
  milestoned: "Milestoned",
  demilestoned: "Milestone removed",
  renamed: "Renamed",
  missed_activity: "Missed activity",
};

function describe(event: IssueInboxEvent): string {
  const source =
    event.sourceProject !== null
      ? ` from ${event.sourceProject}`
      : event.author !== null
        ? ` by ${event.author}`
        : "";
  return `${KIND_LABELS[event.kind]}${source} · ${formatRelativeTimeLabel(event.occurredAt)}`;
}

/** The repository's unread external issue activity on the Issues page, high priority first. */
export function IssueInboxSection(props: {
  readonly environmentId: EnvironmentId;
  readonly reference: IssueRepositoryRef;
  readonly issues?: readonly IssueSummary[] | undefined;
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
  readonly issues?: readonly IssueSummary[] | undefined;
}) {
  const { data } = useEnvironmentQuery(issueEnvironment.inbox({ environmentId, input: reference }));
  const markRead = useAtomCommand(issueEnvironment.markInboxRead);
  const canMark = useAtomValue(issueEnvironment.markInboxRead.permissionAtom(environmentId));
  const events = data?.events ?? [];
  const issuesByNumber = new Map(issues?.map((issue) => [issue.number, issue]));
  if (events.length === 0) return null;
  const mark = (ids?: ReadonlyArray<number>) =>
    void markRead({
      environmentId,
      input: { ...reference, ...(ids === undefined ? {} : { ids }) },
    });
  return (
    <section
      aria-label="Inbox"
      className="my-1 ms-6 me-3 rounded-lg border border-border/60 px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">
          Inbox <span className="font-normal text-muted-foreground">{events.length} unread</span>
        </h3>
        {canMark ? (
          <Button onClick={() => mark()} size="xs" variant="ghost">
            Mark all read
          </Button>
        ) : null}
      </div>
      <ul className="mt-1 flex flex-col gap-1.5">
        {events.map((event) => {
          const issue = issuesByNumber.get(event.issueNumber);
          return (
            <li key={event.id} className="flex items-start gap-2 text-xs">
              {issue ? <IssueStateIcon issue={issue} /> : null}
              <div className="min-w-0 flex-1">
                <a
                  className="font-medium underline-offset-2 hover:underline"
                  href={event.url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {event.issueNumber > 0 ? `#${event.issueNumber} ` : ""}
                  {event.issueTitle}
                </a>
                <p className="text-muted-foreground">{describe(event)}</p>
                {event.snippet !== "" ? (
                  <p className="truncate text-muted-foreground">{event.snippet}</p>
                ) : null}
              </div>
              {event.highPriority ? (
                <Badge size="sm" variant="warning">
                  High priority
                </Badge>
              ) : null}
              {event.tagged ? (
                <Badge size="sm" variant="info">
                  Tagged
                </Badge>
              ) : null}
              {canMark ? (
                <Button onClick={() => mark([event.id])} size="xs" variant="ghost">
                  Mark read
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
