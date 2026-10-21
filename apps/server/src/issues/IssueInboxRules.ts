/**
 * Who wrote a GitHub issue write, whether it is tagged for the repository orchestrator, and the
 * one-line notes that tell it. Every agent writes with the owner's own `gh` login, so Inbox membership
 * comes from another project's marker, never from the GitHub login.
 */
import type { IssueInboxEventKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const CROSS_PROJECT_LABEL = "cross-project";
export const EXTERNAL_LABEL = "external";
export const HIGH_PRIORITY_LABEL = "priority: high";
const LABEL_MAX_LENGTH = 50;

export const fromLabel = (project: string) => `from:${project}`.slice(0, LABEL_MAX_LENGTH);

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

const isBot = (author: GitHubAuthor | null | undefined) =>
  author != null && (author.type === "Bot" || author.login.toLowerCase().endsWith("[bot]"));

export type WriteOrigin =
  | { readonly origin: "own" }
  | { readonly origin: "bot" }
  | {
      readonly origin: "external";
      readonly sourceProject: string;
    };

/** The source marker of another project's write; null for unmarked or this repository's own. */
export function foreignMarker(body: string, repositoryKey: string): SourceMarker | null {
  const marker = parseSourceMarker(body);
  return marker === null || marker.repository?.toLowerCase() === repositoryKey ? null : marker;
}

/**
 * Classifies an issue body or comment in the watched repository (`repositoryKey` is
 * `host/owner/name`, lowercase). Only another project's source marker is Inbox news.
 */
export function classifyWrite(input: {
  readonly body: string;
  readonly author: GitHubAuthor | null | undefined;
  readonly repositoryKey: string;
}): WriteOrigin {
  if (isBot(input.author)) return { origin: "bot" };
  const marker = foreignMarker(input.body, input.repositoryKey);
  return marker === null
    ? { origin: "own" }
    : { origin: "external", sourceProject: marker.project };
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
    ? " Review each item, revise it if needed with propose_issue_change, then acknowledge it with t3_issue_inbox mark_read to place the issue in Ready."
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
