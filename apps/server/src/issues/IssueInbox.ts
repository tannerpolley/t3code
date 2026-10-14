/**
 * The cross-project issue inbox: a watcher that records external GitHub issue activity for each
 * repository with a repository orchestrator, the digests that wake it, and `t3_issue_post`.
 * IssueWorkService's `repository-issue-work` scheduler source drives `pollDue`.
 */
import {
  CommandId,
  IssueReadError,
  pullRequestHostOf,
  SourceControlProviderKind,
  IssueWorkError,
  MessageId,
  ThreadId,
  type IssueInboxEvent,
  type IssueInboxEventKind,
  type IssueInboxListResult,
  type IssueInboxMarkReadInput,
  type IssueInboxMarkReadResult,
  type IssueInboxToolInput,
  type IssueInboxToolResult,
  type IssueInboxUnread,
  type IssuePostInput,
  type IssuePostResult,
  type IssueRepositoryRef,
} from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Hash from "effect/Hash";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { IssueService } from "./IssueService.ts";
import {
  CROSS_PROJECT_LABEL,
  EXTERNAL_LABEL,
  HIGH_PRIORITY_LABEL,
  classifyWrite,
  digestText,
  fromLabel,
  hasLabel,
  isBot,
  isReceiverLabel,
  isTagged,
  noteEvent,
  parseSourceMarker,
  projectSlug,
  snippet,
  sourceMarker,
} from "./IssueInboxRules.ts";

const POLL_INTERVAL_MS = 2 * 60_000;
export const DIGEST_INTERVAL_MS = 15 * 60_000;
/** A GitHub event this close to one of T3's own issue changes is that change. */
const OWN_WRITE_WINDOW_MINUTES = 10;
const EVENTS_PATH = "issues/events?per_page=100";
const LABEL_COLORS: Record<string, string> = {
  [EXTERNAL_LABEL]: "1d76db",
  [HIGH_PRIORITY_LABEL]: "b60205",
};

const Author = Schema.NullOr(
  Schema.Struct({ login: Schema.String, type: Schema.optional(Schema.String) }),
);
const Labels = Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.String }))));
const RawIssue = Schema.Struct({
  id: Schema.Number,
  number: Schema.Number,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Author),
  labels: Labels,
  milestone: Schema.optional(Schema.NullOr(Schema.Struct({ number: Schema.Number }))),
  created_at: Schema.String,
  updated_at: Schema.String,
  html_url: Schema.String,
  pull_request: Schema.optional(Schema.Unknown),
});
const RawComment = Schema.Struct({
  id: Schema.Number,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Author),
  created_at: Schema.String,
  updated_at: Schema.String,
  html_url: Schema.String,
  issue_url: Schema.String,
});
const RawEvent = Schema.Struct({
  id: Schema.Number,
  event: Schema.String,
  actor: Schema.optional(Author),
  created_at: Schema.String,
  label: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
  milestone: Schema.optional(Schema.NullOr(Schema.Struct({ title: Schema.String }))),
  issue: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        number: Schema.Number,
        title: Schema.String,
        html_url: Schema.String,
        labels: Labels,
        pull_request: Schema.optional(Schema.Unknown),
      }),
    ),
  ),
});
const RawCreated = Schema.Struct({
  id: Schema.Number,
  number: Schema.optional(Schema.Number),
  html_url: Schema.String,
});
const decodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
const decodeIssues = decodeJson(Schema.Array(RawIssue));
const decodeComments = decodeJson(Schema.Array(RawComment));
const decodeEvents = decodeJson(Schema.Array(RawEvent));
const decodeLabels = decodeJson(Schema.Array(Schema.Struct({ name: Schema.String })));
const decodeCreated = decodeJson(RawCreated);

const EVENT_KINDS: Partial<Record<string, IssueInboxEventKind>> = {
  closed: "closed",
  reopened: "reopened",
  labeled: "labeled",
  milestoned: "milestoned",
};
const CHANGE_TYPES: Partial<Record<IssueInboxEventKind, ReadonlyArray<string>>> = {
  closed: ["state"],
  reopened: ["state"],
  milestoned: ["milestone", "create", "split"],
};

export interface WatchedRepository {
  readonly host: string;
  readonly repositoryId: string;
  readonly repository: string;
  readonly rootThreadId: ThreadId;
}

interface NewEvent {
  readonly key: string;
  readonly kind: IssueInboxEventKind;
  readonly issueNumber: number;
  readonly issueTitle: string;
  readonly author: string | null;
  readonly sourceProject: string | null;
  readonly tagged: boolean;
  readonly highPriority: boolean;
  readonly needsTriage: boolean;
  readonly url: string;
  readonly snippet: string;
  readonly occurredAt: string;
}

interface StateRow {
  readonly watched_since: string;
  readonly issues_since: string;
  readonly comments_since: string;
  readonly events_after: number | null;
  readonly issues_etag: string | null;
  readonly comments_etag: string | null;
  readonly events_etag: string | null;
}

interface IssueRow {
  readonly issue_number: number;
  readonly title: string;
  readonly content_hash: string;
  readonly cross_project: number;
  readonly external_source: string | null;
  readonly labeled: number;
}

interface EventRow {
  readonly event_id: number;
  readonly host: string;
  readonly repository: string;
  readonly issue_number: number;
  readonly issue_title: string;
  readonly kind: IssueInboxEventKind;
  readonly author: string | null;
  readonly source_project: string | null;
  readonly tagged: number;
  readonly high_priority: number;
  readonly needs_triage: number;
  readonly url: string;
  readonly snippet: string;
  readonly occurred_at: string;
  readonly read_at: string | null;
}

const toEvent = (row: EventRow): IssueInboxEvent => ({
  id: row.event_id,
  host: row.host,
  repository: row.repository,
  issueNumber: row.issue_number,
  issueTitle: row.issue_title,
  kind: row.kind,
  author: row.author,
  sourceProject: row.source_project,
  tagged: row.tagged === 1,
  highPriority: row.high_priority === 1,
  needsTriage: row.needs_triage === 1,
  url: row.url,
  snippet: row.snippet,
  occurredAt: row.occurred_at,
  readAt: row.read_at,
});

// Change detection only: a 32-bit collision hides one edit.
const contentHash = (title: string, body: string) => String(Hash.string(`${title}\u0000${body}`));

const isIssueWorkError = Schema.is(IssueWorkError);
const isIssueReadError = Schema.is(IssueReadError);
const storageError = (cause: unknown) =>
  new IssueWorkError({
    code: "orchestration-error",
    message: `The issue inbox could not be read or saved: ${String(cause)}`,
  });

export class IssueInbox extends Context.Service<
  IssueInbox,
  {
    /** Polls every managed repository at most every two minutes, then delivers due digests. */
    readonly pollDue: Effect.Effect<void>;
    readonly list: (
      input: IssueRepositoryRef,
    ) => Effect.Effect<IssueInboxListResult, IssueWorkError>;
    readonly markRead: (
      input: IssueInboxMarkReadInput,
    ) => Effect.Effect<IssueInboxMarkReadResult, IssueWorkError>;
    /** Unread counts per repository orchestrator, re-sent after every inbox change. */
    readonly unread: Stream.Stream<ReadonlyArray<IssueInboxUnread>, IssueWorkError>;
    /** `t3_issue_inbox` for a repository orchestrator or one of its descendants. */
    readonly forCaller: (
      callerThreadId: ThreadId,
      input: IssueInboxToolInput,
    ) => Effect.Effect<IssueInboxToolResult, IssueWorkError>;
    /** `t3_issue_post`: marks and labels a write when it targets another project's repository. */
    readonly post: (
      callerThreadId: ThreadId,
      input: IssuePostInput,
    ) => Effect.Effect<IssuePostResult, IssueWorkError | IssueReadError>;
  }
>()("t3/issues/IssueInbox") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const issues = yield* IssueService;
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectService;
  const changes = yield* PubSub.sliding<void>(1);
  const changed = PubSub.publish(changes, undefined);
  // GitHub's own timestamp shape, so cursors compare as strings with GitHub's.
  const isoSeconds = (millis: number) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)).replace(/\.\d{3}Z$/u, "Z");
  const nowIso = Clock.currentTimeMillis.pipe(Effect.map(isoSeconds));

  const rest = (
    repo: Pick<WatchedRepository, "host" | "repository">,
    path: string,
    options: { readonly etag?: string | null; readonly body?: unknown } = {},
  ) =>
    issues.repositoryRest({
      host: repo.host,
      repository: repo.repository,
      path,
      ...(options.body === undefined ? {} : { method: "POST" as const, body: options.body }),
      ...(options.etag == null ? {} : { ifNoneMatch: options.etag }),
    });

  /** Creates labels the repository lacks, with T3's colors. A failed create is retried by GitHub's own add. */
  const ensureLabels = (
    repo: Pick<WatchedRepository, "host" | "repository">,
    names: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const existing = new Set(
        (yield* decodeLabels((yield* rest(repo, "labels?per_page=100")).body)).map((label) =>
          label.name.toLowerCase(),
        ),
      );
      for (const name of names)
        if (!existing.has(name.toLowerCase()))
          yield* rest(repo, "labels", {
            body: { name, color: LABEL_COLORS[name] ?? "ededed" },
          }).pipe(Effect.catch(() => Effect.void));
    });

  const watched = sql<{
    host: string;
    repository_id: string;
    repository: string;
    root_thread_id: string;
  }>`
    SELECT o.host, o.repository_id, o.repository, o.root_thread_id
    FROM orchestration_v2_projection_repository_orchestration o
    JOIN orchestration_v2_projection_threads t ON t.thread_id = o.root_thread_id
    WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
  `.pipe(
    Effect.map((rows) =>
      rows.map((row): WatchedRepository => ({
        host: row.host,
        repositoryId: row.repository_id,
        repository: row.repository,
        rootThreadId: ThreadId.make(row.root_thread_id),
      })),
    ),
  );

  /** Whether a GitHub event matches one of T3's own issue changes for that issue. */
  const matchesIssueChange = (
    repo: WatchedRepository,
    issueNumber: number,
    kind: IssueInboxEventKind,
    at: string,
  ) => {
    const types = CHANGE_TYPES[kind];
    if (types === undefined) return Effect.succeed(false);
    // ponytail: matched by issue, operation and time window; a hand edit of the same kind within
    // the window of a T3 change reads as T3's own.
    return sql`
      SELECT 1 FROM issue_changes c
      JOIN orchestration_v2_effect_outbox e ON e.effect_id = 'effect:issue-change:' || c.change_id
      WHERE lower(c.host) = ${repo.host.toLowerCase()}
        AND lower(c.repository) = ${repo.repository.toLowerCase()}
        AND (c.issue_number = ${issueNumber} OR EXISTS (
          SELECT 1 FROM issue_change_targets t
          WHERE t.change_id = c.change_id AND t.issue_number = ${issueNumber}))
        AND c.status IN ('executing', 'succeeded')
        AND json_extract(c.proposal_json, '$.operation.type') IN ${sql.in(types)}
        AND abs(julianday(e.updated_at) - julianday(${at})) * 1440 <= ${OWN_WRITE_WINDOW_MINUTES}
      LIMIT 1
    `.pipe(Effect.map((rows) => rows.length > 0));
  };

  const pollRepository = (repo: WatchedRepository) =>
    Effect.gen(function* () {
      const [state] = yield* sql<StateRow>`
        SELECT watched_since, issues_since, comments_since, events_after,
          issues_etag, comments_etag, events_etag
        FROM issue_inbox_repositories
        WHERE host = ${repo.host} AND repository_id = ${repo.repositoryId}
      `;
      if (state === undefined) {
        // History before watching starts is not news: start every cursor now.
        const now = yield* nowIso;
        const response = yield* rest(repo, EVENTS_PATH);
        const latest = Math.max(
          0,
          ...(yield* decodeEvents(response.body)).map((event) => event.id),
        );
        yield* sql`
          INSERT INTO issue_inbox_repositories (host, repository_id, watched_since, issues_since,
            comments_since, events_after, events_etag)
          VALUES (${repo.host}, ${repo.repositoryId}, ${now}, ${now}, ${now}, ${latest},
            ${response.etag})
          ON CONFLICT DO NOTHING
        `;
        return;
      }
      const repositoryKey = `${repo.host}/${repo.repository}`.toLowerCase();
      const issuesResponse = yield* rest(
        repo,
        `issues?state=all&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(state.issues_since)}`,
        { etag: state.issues_etag },
      );
      const commentsResponse = yield* rest(
        repo,
        `issues/comments?sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(state.comments_since)}`,
        { etag: state.comments_etag },
      );
      const eventsResponse = yield* rest(repo, EVENTS_PATH, { etag: state.events_etag });
      const listedIssues =
        issuesResponse.status === 304 ? [] : yield* decodeIssues(issuesResponse.body);
      const comments =
        commentsResponse.status === 304 ? [] : yield* decodeComments(commentsResponse.body);
      const allEvents =
        eventsResponse.status === 304 ? [] : yield* decodeEvents(eventsResponse.body);
      const issueList = listedIssues.filter((issue) => issue.pull_request === undefined);
      const listed = new Map(issueList.map((issue) => [issue.number, issue]));
      const commentNumbers = new Map<number, number>();
      for (const comment of comments) {
        const number = Number(/\/issues\/(\d+)$/u.exec(comment.issue_url)?.[1]);
        if (Number.isSafeInteger(number) && !comment.html_url.includes("/pull/"))
          commentNumbers.set(comment.id, number);
      }
      const eventsAfter = state.events_after ?? 0;
      const newEvents = allEvents.filter(
        (event) =>
          event.id > eventsAfter && event.issue != null && event.issue.pull_request === undefined,
      );
      const numbers = [
        ...new Set([
          ...listed.keys(),
          ...commentNumbers.values(),
          ...newEvents.map((event) => event.issue!.number),
        ]),
      ];
      const known = new Map(
        numbers.length === 0
          ? []
          : (yield* sql<IssueRow>`
              SELECT issue_number, title, content_hash, cross_project, external_source, labeled
              FROM issue_inbox_issues
              WHERE host = ${repo.host} AND repository_id = ${repo.repositoryId}
                AND issue_number IN ${sql.in(numbers)}
            `).map((row) => [row.issue_number, row]),
      );
      const ownWrites = new Set(
        (yield* sql<{ item: string }>`
          SELECT item FROM issue_inbox_own_writes
          WHERE host = ${repo.host} AND repository = ${repo.repository.toLowerCase()}
        `).map((row) => row.item),
      );
      // Issues opened externally, including ones first seen in this poll.
      const externalSources = new Map(
        [...known.values()].map((row) => [row.issue_number, row.external_source]),
      );
      const isExternalIssue = (number: number) => (externalSources.get(number) ?? null) !== null;
      const highPriority = (number: number, labels: ReadonlyArray<string>) =>
        hasLabel(labels, HIGH_PRIORITY_LABEL) || isExternalIssue(number);
      const inserts: NewEvent[] = [];
      const issueRows: Array<Omit<IssueRow, "labeled"> & { readonly labeled: number }> = [];

      for (const issue of issueList) {
        const body = issue.body ?? "";
        const labels = issue.labels?.map((label) => label.name) ?? [];
        const hash = contentHash(issue.title, body);
        const previous = known.get(issue.number);
        let externalSource = previous?.external_source ?? null;
        let labeled = previous?.labeled ?? 1;
        const base = {
          issueNumber: issue.number,
          issueTitle: issue.title,
          url: issue.html_url,
          snippet: snippet(body),
        };
        if (previous === undefined && issue.created_at >= state.watched_since) {
          const origin = classifyWrite({
            body,
            author: issue.user,
            repositoryKey,
            ownRecord: ownWrites.has(`issue:${issue.number}`),
          });
          if (origin.origin === "external") {
            externalSource = origin.sourceProject ?? "";
            labeled =
              hasLabel(labels, EXTERNAL_LABEL) && hasLabel(labels, HIGH_PRIORITY_LABEL) ? 1 : 0;
            inserts.push({
              ...base,
              key: `opened:${issue.number}`,
              kind: "issue_opened",
              author: issue.user?.login ?? null,
              sourceProject: origin.sourceProject,
              tagged: isTagged({ body, labels, marked: origin.marked }),
              highPriority: true,
              needsTriage: issue.milestone == null,
              occurredAt: issue.created_at,
            });
          }
        } else if (previous !== undefined && previous.content_hash !== hash) {
          // The editor is unknown; T3's own body edits match its recorded baseline exactly.
          const [baseline] = yield* sql<{ body: string }>`
            SELECT body FROM issue_body_baselines
            WHERE host = ${repo.host} AND issue_id = ${String(issue.id)}
          `;
          if (previous.title !== issue.title || baseline?.body !== body)
            inserts.push({
              ...base,
              key: `edited:${issue.number}:${hash}`,
              kind: "edited",
              author: null,
              sourceProject: parseSourceMarker(body)?.project ?? null,
              tagged: isTagged({ body, labels, marked: false }),
              highPriority: highPriority(issue.number, labels),
              needsTriage: false,
              occurredAt: issue.updated_at,
            });
        }
        externalSources.set(issue.number, externalSource);
        issueRows.push({
          issue_number: issue.number,
          title: issue.title,
          content_hash: hash,
          cross_project: hasLabel(labels, CROSS_PROJECT_LABEL) ? 1 : 0,
          external_source: externalSource,
          labeled,
        });
      }

      for (const comment of comments) {
        const number = commentNumbers.get(comment.id);
        if (number === undefined) continue;
        const body = comment.body ?? "";
        const origin = classifyWrite({
          body,
          author: comment.user,
          repositoryKey,
          ownRecord: ownWrites.has(`comment:${comment.id}`),
        });
        if (origin.origin !== "external") continue;
        const issue = listed.get(number);
        const labels =
          issue?.labels?.map((label) => label.name) ??
          (known.get(number)?.cross_project === 1 ? [CROSS_PROJECT_LABEL] : []);
        inserts.push({
          key: `comment:${comment.id}:${comment.updated_at}`,
          kind: comment.created_at === comment.updated_at ? "comment" : "edited",
          issueNumber: number,
          issueTitle: issue?.title ?? known.get(number)?.title ?? "",
          author: comment.user?.login ?? null,
          sourceProject: origin.sourceProject,
          tagged: isTagged({ body, labels, marked: origin.marked }),
          highPriority: highPriority(number, labels),
          needsTriage: false,
          url: comment.html_url,
          snippet: snippet(body),
          occurredAt: comment.updated_at,
        });
      }

      for (const event of newEvents) {
        const kind = EVENT_KINDS[event.event];
        const issue = event.issue!;
        if (kind === undefined || isBot(event.actor)) continue;
        if (kind === "labeled" && event.label != null && isReceiverLabel(event.label.name))
          continue;
        if (yield* matchesIssueChange(repo, issue.number, kind, event.created_at)) continue;
        const labels = issue.labels?.map((label) => label.name) ?? [];
        inserts.push({
          key: `event:${event.id}`,
          kind,
          issueNumber: issue.number,
          issueTitle: issue.title,
          author: event.actor?.login ?? null,
          sourceProject: null,
          tagged:
            hasLabel(labels, CROSS_PROJECT_LABEL) ||
            event.label?.name.toLowerCase() === CROSS_PROJECT_LABEL,
          highPriority: highPriority(issue.number, labels),
          needsTriage: false,
          url: issue.html_url,
          snippet:
            kind === "labeled" && event.label != null
              ? `Label: ${event.label.name}`
              : kind === "milestoned" && event.milestone != null
                ? `Milestone: ${event.milestone.title}`
                : "",
          occurredAt: event.created_at,
        });
      }

      const latest = (values: ReadonlyArray<string>, fallback: string) =>
        values.reduce((max, value) => (value > max ? value : max), fallback);
      const inserted = yield* sql.withTransaction(
        Effect.gen(function* () {
          let count = 0;
          for (const event of inserts) {
            const rows = yield* sql`
              INSERT INTO issue_inbox_events (host, repository_id, repository, event_key,
                issue_number, issue_title, kind, author, source_project, tagged, high_priority,
                needs_triage, url, snippet, occurred_at)
              VALUES (${repo.host}, ${repo.repositoryId}, ${repo.repository}, ${event.key},
                ${event.issueNumber}, ${event.issueTitle}, ${event.kind}, ${event.author},
                ${event.sourceProject}, ${event.tagged ? 1 : 0}, ${event.highPriority ? 1 : 0},
                ${event.needsTriage ? 1 : 0}, ${event.url}, ${event.snippet}, ${event.occurredAt})
              ON CONFLICT (host, repository_id, event_key) DO NOTHING
              RETURNING event_id
            `;
            count += rows.length;
          }
          for (const row of issueRows)
            yield* sql`
              INSERT INTO issue_inbox_issues (host, repository_id, issue_number, title,
                content_hash, cross_project, external_source, labeled)
              VALUES (${repo.host}, ${repo.repositoryId}, ${row.issue_number}, ${row.title},
                ${row.content_hash}, ${row.cross_project}, ${row.external_source}, ${row.labeled})
              ON CONFLICT (host, repository_id, issue_number) DO UPDATE SET
                title = excluded.title, content_hash = excluded.content_hash,
                cross_project = excluded.cross_project
            `;
          yield* sql`
            UPDATE issue_inbox_repositories SET
              issues_since = ${latest(
                listedIssues.map((issue) => issue.updated_at),
                state.issues_since,
              )},
              comments_since = ${latest(
                comments.map((comment) => comment.updated_at),
                state.comments_since,
              )},
              events_after = ${Math.max(eventsAfter, ...allEvents.map((event) => event.id))},
              issues_etag = ${issuesResponse.status === 304 ? state.issues_etag : issuesResponse.etag},
              comments_etag = ${commentsResponse.status === 304 ? state.comments_etag : commentsResponse.etag},
              events_etag = ${eventsResponse.status === 304 ? state.events_etag : eventsResponse.etag}
            WHERE host = ${repo.host} AND repository_id = ${repo.repositoryId}
          `;
          return count;
        }),
      );
      if (inserted > 0) yield* changed;
      yield* enforceLabels(repo);
    });

  /** Labels each external issue once; an owner who removes a label later keeps it removed. */
  const enforceLabels = (repo: WatchedRepository) =>
    Effect.gen(function* () {
      const pending = yield* sql<{ issue_number: number; external_source: string }>`
        SELECT issue_number, external_source FROM issue_inbox_issues
        WHERE host = ${repo.host} AND repository_id = ${repo.repositoryId}
          AND external_source IS NOT NULL AND labeled = 0
      `;
      for (const row of pending) {
        const labels = [
          EXTERNAL_LABEL,
          HIGH_PRIORITY_LABEL,
          ...(row.external_source === "" ? [] : [fromLabel(row.external_source)]),
        ];
        yield* ensureLabels(repo, labels);
        yield* rest(repo, `issues/${row.issue_number}/labels`, { body: { labels } });
        yield* sql`
          UPDATE issue_inbox_issues SET labeled = 1
          WHERE host = ${repo.host} AND repository_id = ${repo.repositoryId}
            AND issue_number = ${row.issue_number}
        `;
      }
    });

  /**
   * At most one digest per repository every 15 minutes, only for tagged events no note or digest
   * has told yet. The digest row commits before dispatch, and its command id makes a retry after
   * a restart replay instead of sending twice.
   */
  const deliverDigest = (repo: WatchedRepository) =>
    Effect.gen(function* () {
      let pending = yield* sql<{ digest_id: number; text: string }>`
        SELECT digest_id, text FROM issue_inbox_digests
        WHERE host = ${repo.host} AND repository_id = ${repo.repositoryId} AND delivered_at IS NULL
        ORDER BY digest_id
      `;
      if (pending.length === 0) {
        const now = yield* Clock.currentTimeMillis;
        const [last] = yield* sql<{ created_at: string | null }>`
          SELECT MAX(created_at) AS created_at FROM issue_inbox_digests
          WHERE host = ${repo.host} AND repository_id = ${repo.repositoryId}
        `;
        if (last?.created_at != null && now - Date.parse(last.created_at) < DIGEST_INTERVAL_MS)
          return;
        const tagged = yield* sql<EventRow>`
          SELECT * FROM issue_inbox_events
          WHERE host = ${repo.host} AND repository_id = ${repo.repositoryId}
            AND read_at IS NULL AND noted_by IS NULL AND tagged = 1
          ORDER BY high_priority DESC, event_id
        `;
        if (tagged.length === 0) return;
        const since = tagged
          .map((event) => event.occurred_at)
          .reduce((min, value) => (value < min ? value : min));
        const text = digestText(tagged.map(noteEvent), since);
        const createdAt = isoSeconds(now);
        pending = yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ digest_id: number; text: string }>`
              INSERT INTO issue_inbox_digests (host, repository_id, text, created_at)
              VALUES (${repo.host}, ${repo.repositoryId}, ${text}, ${createdAt})
              RETURNING digest_id, text
            `;
            yield* sql`
              UPDATE issue_inbox_events SET noted_by = ${`digest:${rows[0]!.digest_id}`}
              WHERE event_id IN ${sql.in(tagged.map((event) => event.event_id))}
            `;
            return rows;
          }),
        );
      }
      for (const digest of pending) {
        const id = `issue-inbox-digest:${digest.digest_id}:${repo.rootThreadId}`;
        // Queued, never steered: Claude's steering interrupts running tools. Idle, it starts a turn.
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          threadId: repo.rootThreadId,
          messageId: MessageId.make(id),
          text: digest.text,
          notification: {
            source: { kind: "system" },
            outcome: "updated",
            summary: "Tagged external issue activity",
            detail: digest.text,
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        });
        yield* sql`
          UPDATE issue_inbox_digests SET delivered_at = ${yield* nowIso}
          WHERE digest_id = ${digest.digest_id}
        `;
      }
    });

  let nextPollAt = 0;
  const pollDue = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now < nextPollAt) return;
    nextPollAt = now + POLL_INTERVAL_MS;
    for (const repo of yield* watched) {
      yield* pollRepository(repo).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Issue inbox poll failed", { repository: repo.repository, cause }),
        ),
      );
      yield* deliverDigest(repo).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Issue inbox digest failed", { repository: repo.repository, cause }),
        ),
      );
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Issue inbox poll failed", { cause })));

  const unreadEvents = (repo: IssueRepositoryRef, ids?: ReadonlyArray<number>) =>
    sql<EventRow>`
      SELECT * FROM issue_inbox_events
      WHERE host = ${repo.host.toLowerCase()} AND lower(repository) = ${repo.repository.toLowerCase()}
        AND ${ids === undefined ? sql`read_at IS NULL` : sql`event_id IN ${sql.in(ids)}`}
      ORDER BY high_priority DESC, event_id DESC
      LIMIT 100
    `.pipe(Effect.map((rows) => rows.map(toEvent)));

  const markRead = (input: IssueInboxMarkReadInput) =>
    Effect.gen(function* () {
      if (input.ids?.length === 0) return { marked: 0 };
      const now = yield* nowIso;
      const rows = yield* sql`
        UPDATE issue_inbox_events SET read_at = ${now}
        WHERE host = ${input.host.toLowerCase()}
          AND lower(repository) = ${input.repository.toLowerCase()}
          AND ${input.ids === undefined ? sql`read_at IS NULL` : sql`read_at IS NULL AND event_id IN ${sql.in(input.ids)}`}
        RETURNING event_id
      `;
      if (rows.length > 0) yield* changed;
      return { marked: rows.length };
    });

  const unreadCounts = sql<{
    host: string;
    repository: string;
    root_thread_id: string;
    unread: number;
  }>`
    SELECT o.host, o.repository, o.root_thread_id, COUNT(*) AS unread
    FROM orchestration_v2_projection_repository_orchestration o
    JOIN issue_inbox_events e
      ON e.host = o.host AND e.repository_id = o.repository_id AND e.read_at IS NULL
    GROUP BY o.host, o.repository_id
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        host: row.host,
        repository: row.repository,
        rootThreadId: ThreadId.make(row.root_thread_id),
        unread: row.unread,
      })),
    ),
    Effect.mapError(storageError),
  );

  const callerRepository = (callerThreadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* threads.getThreadShell(callerThreadId);
      const [row] =
        shell === null
          ? []
          : yield* sql<{ host: string; repository: string }>`
              SELECT host, repository FROM orchestration_v2_projection_repository_orchestration
              WHERE root_thread_id = ${shell.lineage.rootThreadId}
            `;
      if (row === undefined)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message:
            "The issue inbox belongs to a repository orchestrator; call it from that orchestrator or one of its delegated children.",
        });
      return row;
    });

  const forCaller: IssueInbox["Service"]["forCaller"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const repo = yield* callerRepository(callerThreadId);
      if (input.action === "read" && (input.ids === undefined || input.ids.length === 0))
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "Pass the ids of the events to read; list them first.",
        });
      if (input.action === "mark_read")
        yield* markRead({ ...repo, ...(input.ids === undefined ? {} : { ids: input.ids }) });
      const events =
        input.action === "mark_read"
          ? []
          : input.action === "read"
            ? yield* unreadEvents(repo, input.ids)
            : (yield* unreadEvents(repo)).map((event) => ({ ...event, snippet: "" }));
      const [count] = yield* sql<{ unread: number }>`
        SELECT COUNT(*) AS unread FROM issue_inbox_events
        WHERE host = ${repo.host} AND lower(repository) = ${repo.repository.toLowerCase()}
          AND read_at IS NULL
      `;
      const unread = count?.unread ?? 0;
      return { repository: repo.repository, unread, events };
    }).pipe(Effect.mapError((cause) => (isIssueWorkError(cause) ? cause : storageError(cause))));

  const post: IssueInbox["Service"]["post"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      if (input.issueNumber === undefined && input.title === undefined)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "Pass a title to create an issue, or an issueNumber to comment on one.",
        });
      const target = {
        host: (input.host ?? "github.com").toLowerCase(),
        repository: input.repository.toLowerCase(),
      };
      const shell = yield* threads
        .getThreadShell(callerThreadId)
        .pipe(Effect.mapError(storageError));
      if (shell === null)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "The calling thread is unavailable.",
        });
      const project = Option.getOrNull(
        yield* projects.getById(shell.projectId).pipe(Effect.mapError(storageError)),
      );
      const identity = project?.repositoryIdentity ?? null;
      const own = [
        identity?.origin?.displayName,
        sourceControlRepositorySelector(identity),
      ].flatMap((name) => (name == null ? [] : [name.toLowerCase()]));
      const ownHost =
        identity === null
          ? null
          : pullRequestHostOf(identity, SourceControlProviderKind.make("github")).toLowerCase();
      const crossProject = !(
        identity?.provider === "github" &&
        ownHost === target.host &&
        own.includes(target.repository)
      );
      const projectName = projectSlug(
        own[0]?.slice(own[0].indexOf("/") + 1) ?? project?.title ?? "project",
      );
      const labels =
        crossProject && input.issueNumber === undefined
          ? [EXTERNAL_LABEL, fromLabel(projectName), HIGH_PRIORITY_LABEL]
          : [];
      const body = crossProject
        ? `${input.body}\n\n${sourceMarker({
            project: projectName,
            repository: own[0] === undefined || ownHost === null ? null : `${ownHost}/${own[0]}`,
            thread: callerThreadId,
          })}`
        : input.body;
      if (labels.length > 0) yield* ensureLabels(target, labels);
      const response =
        input.issueNumber === undefined
          ? yield* rest(target, "issues", {
              body: { title: input.title, body, ...(labels.length > 0 ? { labels } : {}) },
            })
          : yield* rest(target, `issues/${input.issueNumber}/comments`, { body: { body } });
      const created = yield* decodeCreated(response.body).pipe(
        Effect.mapError(
          () =>
            new IssueReadError({
              code: "invalid-response",
              operation: "detail",
              message: "GitHub returned an invalid created issue or comment.",
            }),
        ),
      );
      const issueNumber = input.issueNumber ?? created.number ?? 0;
      if (!crossProject)
        yield* sql`
          INSERT INTO issue_inbox_own_writes (host, repository, item)
          VALUES (${target.host}, ${target.repository},
            ${input.issueNumber === undefined ? `issue:${issueNumber}` : `comment:${created.id}`})
          ON CONFLICT DO NOTHING
        `.pipe(Effect.mapError(storageError));
      return {
        url: created.html_url,
        issueNumber,
        commentId: input.issueNumber === undefined ? null : String(created.id),
        crossProject,
        labels,
      };
    }).pipe(
      Effect.mapError((cause) =>
        isIssueWorkError(cause) || isIssueReadError(cause) ? cause : storageError(cause),
      ),
    );

  return IssueInbox.of({
    pollDue,
    list: (input) =>
      unreadEvents(input).pipe(
        Effect.map((events) => ({ events })),
        Effect.mapError(storageError),
      ),
    markRead: (input) => markRead(input).pipe(Effect.mapError(storageError)),
    unread: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(unreadCounts),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => unreadCounts)),
        );
      }),
    ),
    forCaller,
    post,
  });
});

export const layer = Layer.effect(IssueInbox, make);
