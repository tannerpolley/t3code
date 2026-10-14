/**
 * Who wrote a GitHub issue write, whether it is tagged for the repository orchestrator, and the
 * one-line notes that tell it. Every agent writes with the owner's own `gh` login, so authorship
 * comes from markers and T3's own records, never from the GitHub author.
 */
import type { IssueInboxEventKind } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const CROSS_PROJECT_LABEL = "cross-project";
export const EXTERNAL_LABEL = "external";
export const HIGH_PRIORITY_LABEL = "priority: high";
const LABEL_MAX_LENGTH = 50;

export const fromLabel = (project: string) => `from:${project}`.slice(0, LABEL_MAX_LENGTH);

/** Labels `t3_issue_post` and receiver enforcement add: bookkeeping, never news. */
export function isReceiverLabel(name: string): boolean {
  const label = name.toLowerCase();
  return label === EXTERNAL_LABEL || label === HIGH_PRIORITY_LABEL || label.startsWith("from:");
}

export const hasLabel = (labels: ReadonlyArray<string>, name: string) =>
  labels.some((label) => label.toLowerCase() === name);

/** A label- and marker-safe project name: `Amine Thermodynamics` → `amine-thermodynamics`. */
export function projectSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length > 0 ? slug.slice(0, LABEL_MAX_LENGTH - 5) : "project";
}

export interface SourceMarker {
  readonly project: string;
  /** `host/owner/name` of the writing project, when it has one. */
  readonly repository: string | null;
  readonly thread: string;
}

export function sourceMarker(marker: SourceMarker): string {
  return `<!-- t3-source project=${encodeURIComponent(marker.project)} repository=${encodeURIComponent(marker.repository ?? "-")} thread=${encodeURIComponent(marker.thread)} -->`;
}

const SOURCE_MARKER = /<!-- t3-source project=(\S+) repository=(\S+) thread=(\S+) -->/u;

export function parseSourceMarker(body: string): SourceMarker | null {
  const match = SOURCE_MARKER.exec(body);
  if (match === null) return null;
  try {
    const repository = decodeURIComponent(match[2]!);
    return {
      project: decodeURIComponent(match[1]!),
      repository: repository === "-" ? null : repository,
      thread: decodeURIComponent(match[3]!),
    };
  } catch {
    return null;
  }
}

export interface GitHubAuthor {
  readonly login: string;
  readonly type?: string | undefined;
}

export const isBot = (author: GitHubAuthor | null | undefined) =>
  author != null && (author.type === "Bot" || author.login.toLowerCase().endsWith("[bot]"));

export type WriteOrigin =
  | { readonly origin: "own" }
  | { readonly origin: "bot" }
  | {
      readonly origin: "external";
      readonly sourceProject: string | null;
      /** Carries another project's source marker. */
      readonly marked: boolean;
    };

// T3's managed status, closeout and issue-change writes, as IssueCommentEffects and IssueService write them.
const T3_WRITE_MARKER = /<!-- t3-issue-(?:status|closeout|change):\S+ -->/u;

/** The source marker of another project's write; null for unmarked or this repository's own. */
export function foreignMarker(body: string, repositoryKey: string): SourceMarker | null {
  const marker = parseSourceMarker(body);
  return marker === null || marker.repository?.toLowerCase() === repositoryKey ? null : marker;
}

/**
 * Classifies an issue body or comment in the watched repository (`repositoryKey` is
 * `host/owner/name`, lowercase). `ownRecord` is a match in T3's own write records.
 */
export function classifyWrite(input: {
  readonly body: string;
  readonly author: GitHubAuthor | null | undefined;
  readonly repositoryKey: string;
  readonly ownRecord: boolean;
}): WriteOrigin {
  if (isBot(input.author)) return { origin: "bot" };
  if (input.ownRecord || T3_WRITE_MARKER.test(input.body)) return { origin: "own" };
  const marker = parseSourceMarker(input.body);
  if (marker === null) return { origin: "external", sourceProject: null, marked: false };
  return marker.repository?.toLowerCase() === input.repositoryKey
    ? { origin: "own" }
    : { origin: "external", sourceProject: marker.project, marked: true };
}

/** A state or milestone transition one T3 issue write makes. */
export interface WriteTransition {
  readonly kind: "closed" | "reopened" | "milestoned" | "demilestoned";
  readonly milestoneNumber: number | null;
}

/** The transitions a state write makes from `from`; none for a no-op. */
export const stateTransitions = (
  from: "open" | "closed",
  to: "open" | "closed",
): ReadonlyArray<WriteTransition> =>
  from === to ? [] : [{ kind: to === "closed" ? "closed" : "reopened", milestoneNumber: null }];

/** The transitions a milestone write makes from `from`; none for a no-op. */
export const milestoneTransitions = (
  from: number | null,
  to: number | null,
): ReadonlyArray<WriteTransition> =>
  from === to
    ? []
    : [
        ...(from === null ? [] : [{ kind: "demilestoned" as const, milestoneNumber: from }]),
        ...(to === null ? [] : [{ kind: "milestoned" as const, milestoneNumber: to }]),
      ];

/**
 * Runs one T3 GitHub issue write and records the transitions it made with the request's time
 * span, so the inbox watcher reads the events GitHub logs for it as T3's own. `made` names the
 * issue and transitions from the write's result.
 *
 * Known limits, both after a lost GitHub response: a write GitHub applied but answered with an
 * error records no receipt, so its event reads as external; and a create recovered by its marker
 * records a `milestoned` receipt spanning the retry, which can claim the owner's same-milestone
 * change made in that span.
 */
export const withWriteReceipts = <A, E, R>(
  sql: SqlClient.SqlClient,
  repository: { readonly host: string; readonly repository: string },
  write: Effect.Effect<A, E, R>,
  made: (result: A) => {
    readonly issueNumber: number;
    readonly transitions: ReadonlyArray<WriteTransition>;
  },
) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const result = yield* write;
    const finishedAt = yield* Clock.currentTimeMillis;
    const { issueNumber, transitions } = made(result);
    for (const transition of transitions)
      yield* sql`
        INSERT INTO issue_inbox_write_receipts (host, repository, issue_number, kind,
          milestone_number, started_at, finished_at)
        VALUES (${repository.host.toLowerCase()}, ${repository.repository.toLowerCase()},
          ${issueNumber}, ${transition.kind}, ${transition.milestoneNumber}, ${startedAt},
          ${finishedAt})
      `.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record an issue write for the inbox", { cause }),
        ),
      );
    return result;
  });

const ORCHESTRATOR_MENTION = /(?<![\w@./-])@orchestrator\b/iu;

/** Tagged events may wake an idle orchestrator; untagged ones wait for its next turn. */
export function isTagged(input: {
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
  readonly marked: boolean;
}): boolean {
  return (
    input.marked ||
    hasLabel(input.labels, CROSS_PROJECT_LABEL) ||
    ORCHESTRATOR_MENTION.test(input.body)
  );
}

export function snippet(body: string, maxLength = 280): string {
  const text = body
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export interface NoteEvent {
  readonly repository: string;
  readonly issueNumber: number;
  readonly kind: IssueInboxEventKind;
  readonly sourceProject: string | null;
  readonly needsTriage: boolean;
}

const KIND_WORDS: Record<IssueInboxEventKind, string> = {
  issue_opened: "opened",
  comment: "comment",
  closed: "closed",
  reopened: "reopened",
  labeled: "labeled",
  unlabeled: "unlabeled",
  milestoned: "milestoned",
  demilestoned: "demilestoned",
  renamed: "renamed",
  missed_activity: "missed activity while T3 was offline",
};
const MAX_LISTED = 6;

/** `epc-saft #61 comment from amine, #62 opened (needs triage)`; callers sort priority first. */
export function listEvents(events: ReadonlyArray<NoteEvent>): string {
  const listed = events.slice(0, MAX_LISTED).map((event, index) => {
    const name = event.repository.slice(event.repository.indexOf("/") + 1);
    const prefix = index === 0 || events[index - 1]!.repository !== event.repository;
    // A missed-activity note concerns the repository, not one issue.
    const issue = event.kind === "missed_activity" ? "" : `#${event.issueNumber} `;
    return `${prefix ? `${name} ` : ""}${issue}${KIND_WORDS[event.kind]}${
      event.sourceProject === null ? "" : ` from ${event.sourceProject}`
    }${event.needsTriage ? " (needs triage)" : ""}`;
  });
  const more = events.length - listed.length;
  return more > 0 ? `${listed.join(", ")} and ${more} more` : listed.join(", ");
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const triageHint = (events: ReadonlyArray<NoteEvent>) =>
  events.some((event) => event.needsTriage)
    ? " Triage new external issues into a milestone; T3 admits nothing outside the selected milestones."
    : "";

/** The idle-wake digest: counts and issue numbers, never bodies. */
export function digestText(events: ReadonlyArray<NoteEvent>, since: string): string {
  return `${plural(events.length, "tagged external issue event")} since ${since.slice(11, 16)} UTC (${listEvents(events)}). Read them with t3_issue_inbox.${triageHint(events)}`;
}

/** The line prepended to the orchestrator's next turn. */
export function turnNoteText(events: ReadonlyArray<NoteEvent>): string {
  return `Issue inbox: ${plural(events.length, "unread external issue event")} (${listEvents(events)}). Read them with t3_issue_inbox.${triageHint(events)}`;
}

interface NoteRow {
  readonly event_id: number;
  readonly repository: string;
  readonly issue_number: number;
  readonly kind: IssueInboxEventKind;
  readonly source_project: string | null;
  readonly needs_triage: number;
}

export const noteEvent = (row: NoteRow): NoteEvent => ({
  repository: row.repository,
  issueNumber: row.issue_number,
  kind: row.kind,
  sourceProject: row.source_project,
  needsTriage: row.needs_triage === 1,
});

/**
 * The inbox line a repository orchestrator's next turn carries, and the events it covers. Other
 * threads get an empty note. Turn starts call this through the inline shell delivery hook.
 */
export const pendingInboxNote = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<NoteRow>`
    SELECT e.event_id, e.repository, e.issue_number, e.kind, e.source_project, e.needs_triage
    FROM orchestration_v2_projection_repository_orchestration o
    JOIN issue_inbox_events e ON e.host = o.host AND e.repository_id = o.repository_id
    WHERE o.root_thread_id = ${threadId} AND e.read_at IS NULL AND e.noted_by IS NULL
    ORDER BY e.high_priority DESC, e.event_id
  `.pipe(
    Effect.map((rows) => ({
      ids: rows.map((row) => row.event_id),
      text: rows.length === 0 ? "" : turnNoteText(rows.map(noteEvent)),
    })),
  );

export const markInboxNoted = (
  sql: SqlClient.SqlClient,
  ids: ReadonlyArray<number>,
  deliveryId: string,
) =>
  ids.length === 0
    ? Effect.void
    : sql`UPDATE issue_inbox_events SET noted_by = ${deliveryId}
        WHERE event_id IN ${sql.in(ids)} AND noted_by IS NULL`.pipe(Effect.asVoid);
