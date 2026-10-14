/**
 * Reads one managed repository's GitHub issue activity since its cursors and records the
 * external part in the inbox tables. Conditional page-1 reads keep an unchanged repository free.
 */
import { IssueReadError, type IssueInboxEventKind, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { IssueService } from "./IssueService.ts";
import {
  CROSS_PROJECT_LABEL,
  EXTERNAL_LABEL,
  HIGH_PRIORITY_LABEL,
  classifyWrite,
  commentVersion,
  contentHash,
  foreignMarker,
  fromLabel,
  hasLabel,
  isBot,
  isReceiverLabel,
  isTagged,
  recordedWrites,
  snippet,
  type RecordedWrite,
} from "./IssueInboxRules.ts";

/** Timestamp cursors re-read this much, so same-second and late-committed writes are not lost. */
const CURSOR_OVERLAP_MS = 5 * 60_000;
/** A recorded T3 write explains a GitHub event only this close to when it ran. */
const OWN_WRITE_WINDOW_MS = 10 * 60_000;
/** Pages per listing per poll; more fails the poll without moving its cursor. */
const MAX_PAGES = 50;
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
const decodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
const decodeIssues = decodeJson(Schema.Array(RawIssue));
const decodeComments = decodeJson(Schema.Array(RawComment));
const decodeEvents = decodeJson(Schema.Array(RawEvent));
const decodeNames = decodeJson(Schema.Array(Schema.Struct({ name: Schema.String })));
const decodeMilestones = decodeJson(
  Schema.Array(Schema.Struct({ number: Schema.Number, title: Schema.String })),
);

const EVENT_KINDS: Partial<Record<string, IssueInboxEventKind>> = {
  closed: "closed",
  reopened: "reopened",
  labeled: "labeled",
  milestoned: "milestoned",
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
  /** Empty when the issue changed while its snapshot was read: its next change reads as an edit. */
  readonly content_hash: string;
  readonly cross_project: number;
  readonly external_source: string | null;
  readonly labeled: number;
}

// GitHub's own timestamp shape, so cursors compare as strings with GitHub's.
export const isoSeconds = (millis: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(millis)).replace(/\.\d{3}Z$/u, "Z");

const writeKey = (write: Pick<RecordedWrite, "changeId" | "issueNumber" | "kind">) =>
  `${write.changeId}:${write.issueNumber}:${write.kind}`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const issues = yield* IssueService;

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

  /**
   * Every page of a listing. A 304 on page 1 means nothing changed: each listing here puts the
   * newest change on page 1. `enough` stops early once the pages read reach seen items.
   */
  const readAll = <A, E>(
    repo: WatchedRepository,
    path: string,
    decode: (body: string) => Effect.Effect<ReadonlyArray<A>, E>,
    etag: string | null = null,
    enough: (items: ReadonlyArray<A>) => boolean = () => false,
  ) =>
    Effect.gen(function* () {
      const first = yield* rest(repo, `${path}&page=1`, { etag });
      if (first.status === 304) return { items: [] as ReadonlyArray<A>, etag };
      const items = [...(yield* decode(first.body))];
      let next = first.nextPage;
      for (let pages = 1; next !== null && !enough(items); pages++) {
        if (pages >= MAX_PAGES)
          return yield* new IssueReadError({
            code: "invalid-response",
            operation: "detail",
            message: `More than ${MAX_PAGES} pages of ${path.split("?")[0]} changed since the last poll.`,
          });
        const page = yield* rest(repo, `${path}&page=${next}`);
        items.push(...(yield* decode(page.body)));
        next = page.nextPage;
      }
      return { items: items as ReadonlyArray<A>, etag: first.etag };
    });

  /** Creates the labels a repository lacks, with T3's colors. */
  const ensureLabels = (
    repo: Pick<WatchedRepository, "host" | "repository">,
    names: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const existing = new Set(
        (yield* decodeNames((yield* rest(repo, "labels?per_page=100")).body)).map((label) =>
          label.name.toLowerCase(),
        ),
      );
      for (const name of names)
        if (!existing.has(name.toLowerCase()))
          yield* rest(repo, "labels", {
            body: { name, color: LABEL_COLORS[name] ?? "ededed" },
          }).pipe(Effect.catch(() => Effect.void));
    });

  const upsertIssue = (repo: WatchedRepository, row: IssueRow) => sql`
    INSERT INTO issue_inbox_issues (host, repository_id, issue_number, title, content_hash,
      cross_project, external_source, labeled)
    VALUES (${repo.host}, ${repo.repositoryId}, ${row.issue_number}, ${row.title},
      ${row.content_hash}, ${row.cross_project}, ${row.external_source}, ${row.labeled})
    ON CONFLICT (host, repository_id, issue_number) DO UPDATE SET
      title = excluded.title, content_hash = excluded.content_hash,
      cross_project = excluded.cross_project
  `;

  /**
   * Starts watching: the event cursor at the newest event, the timestamp cursors a little before
   * now, and a snapshot of open issues so their first edit is news. Nothing is reported.
   */
  const initialize = (repo: WatchedRepository) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const watchedSince = isoSeconds(startedAt);
      const events = yield* rest(repo, `${EVENTS_PATH}&page=1`);
      const latest = Math.max(0, ...(yield* decodeEvents(events.body)).map((event) => event.id));
      // ponytail: one request per 100 open issues, once per repository; MAX_PAGES caps it at 5,000.
      const open = yield* readAll(repo, "issues?state=open&per_page=100", decodeIssues);
      const cursor = isoSeconds(startedAt - CURSOR_OVERLAP_MS);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const issue of open.items) {
            // Opened while initializing: the first poll reports it.
            if (issue.pull_request !== undefined || issue.created_at >= watchedSince) continue;
            yield* upsertIssue(repo, {
              issue_number: issue.number,
              title: issue.title,
              content_hash:
                issue.updated_at >= watchedSince ? "" : contentHash(issue.title, issue.body ?? ""),
              cross_project: hasLabel(
                issue.labels?.map((label) => label.name) ?? [],
                CROSS_PROJECT_LABEL,
              )
                ? 1
                : 0,
              external_source: null,
              labeled: 1,
            });
          }
          yield* sql`
            INSERT INTO issue_inbox_repositories (host, repository_id, watched_since, issues_since,
              comments_since, events_after, events_etag)
            VALUES (${repo.host}, ${repo.repositoryId}, ${watchedSince}, ${cursor}, ${cursor},
              ${latest}, ${events.etag})
            ON CONFLICT DO NOTHING
          `;
        }),
      );
      return 0;
    });

  /** Recorded T3 issue changes that ran recently enough to explain events at or after `since`. */
  const recentWrites = (repo: WatchedRepository, since: string) =>
    sql<{ change_id: string; proposal_json: string; steps_json: string; written_at: string }>`
      SELECT c.change_id, c.proposal_json, c.steps_json, e.updated_at AS written_at
      FROM issue_changes c
      JOIN orchestration_v2_effect_outbox e ON e.effect_id = 'effect:issue-change:' || c.change_id
      WHERE lower(c.host) = ${repo.host.toLowerCase()}
        AND lower(c.repository) = ${repo.repository.toLowerCase()}
        AND c.status IN ('executing', 'succeeded')
        AND julianday(e.updated_at) >= julianday(${since})
    `.pipe(Effect.map((rows) => rows.flatMap(recordedWrites)));

  /** Polls one repository and returns how many new inbox events it recorded. */
  const poll = (repo: WatchedRepository) =>
    Effect.gen(function* () {
      const [state] = yield* sql<StateRow>`
        SELECT watched_since, issues_since, comments_since, events_after,
          issues_etag, comments_etag, events_etag
        FROM issue_inbox_repositories
        WHERE host = ${repo.host} AND repository_id = ${repo.repositoryId}
      `;
      if (state === undefined) return yield* initialize(repo);
      const repositoryKey = `${repo.host}/${repo.repository}`.toLowerCase();
      const eventsAfter = state.events_after ?? 0;
      const issuesRead = yield* readAll(
        repo,
        `issues?state=all&sort=updated&direction=desc&per_page=100&since=${encodeURIComponent(state.issues_since)}`,
        decodeIssues,
        state.issues_etag,
      );
      const commentsRead = yield* readAll(
        repo,
        `issues/comments?sort=updated&direction=desc&per_page=100&since=${encodeURIComponent(state.comments_since)}`,
        decodeComments,
        state.comments_etag,
      );
      const eventsRead = yield* readAll(
        repo,
        EVENTS_PATH,
        decodeEvents,
        state.events_etag,
        (events) => events.some((event) => event.id <= eventsAfter),
      );
      const issueList = issuesRead.items.filter((issue) => issue.pull_request === undefined);
      const listed = new Map(issueList.map((issue) => [issue.number, issue]));
      const comments = commentsRead.items.flatMap((comment) => {
        const number = Number(/\/issues\/(\d+)$/u.exec(comment.issue_url)?.[1]);
        return Number.isSafeInteger(number) &&
          !comment.html_url.includes("/pull/") &&
          comment.updated_at >= state.watched_since
          ? [{ ...comment, number }]
          : [];
      });
      // Oldest first, so an earlier event claims a recorded T3 write before a later one.
      const newEvents = eventsRead.items
        .filter(
          (event) =>
            event.id > eventsAfter && event.issue != null && event.issue.pull_request === undefined,
        )
        .toSorted((left, right) => left.id - right.id);
      const numbers = [
        ...new Set([
          ...listed.keys(),
          ...comments.map((comment) => comment.number),
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
      const highPriority = (number: number, labels: ReadonlyArray<string>) =>
        hasLabel(labels, HIGH_PRIORITY_LABEL) || (externalSources.get(number) ?? null) !== null;
      const inserts: NewEvent[] = [];
      const issueRows: IssueRow[] = [];

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
          if (previous.title !== issue.title || baseline?.body !== body) {
            const marker = foreignMarker(body, repositoryKey);
            inserts.push({
              ...base,
              key: `edited:${issue.number}:${issue.updated_at}`,
              kind: "edited",
              author: null,
              sourceProject: marker?.project ?? null,
              tagged: isTagged({ body, labels, marked: marker !== null }),
              highPriority: highPriority(issue.number, labels),
              needsTriage: false,
              occurredAt: issue.updated_at,
            });
          }
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
        const body = comment.body ?? "";
        const origin = classifyWrite({
          body,
          author: comment.user,
          repositoryKey,
          ownRecord: ownWrites.has(commentVersion(comment.id, comment.updated_at, body)),
        });
        if (origin.origin !== "external") continue;
        const issue = listed.get(comment.number);
        const labels =
          issue?.labels?.map((label) => label.name) ??
          (known.get(comment.number)?.cross_project === 1 ? [CROSS_PROJECT_LABEL] : []);
        inserts.push({
          key: `comment:${comment.id}:${comment.updated_at}`,
          kind: comment.created_at === comment.updated_at ? "comment" : "edited",
          issueNumber: comment.number,
          issueTitle: issue?.title ?? known.get(comment.number)?.title ?? "",
          author: comment.user?.login ?? null,
          sourceProject: origin.sourceProject,
          tagged: isTagged({ body, labels, marked: origin.marked }),
          highPriority: highPriority(comment.number, labels),
          needsTriage: false,
          url: comment.html_url,
          snippet: snippet(body),
          occurredAt: comment.updated_at,
        });
      }

      // State and milestone events T3 wrote itself match one recorded write each, by issue, result
      // and destination, within a short window of when that write ran.
      const writeEvents = newEvents.filter(
        (event) =>
          event.event === "closed" || event.event === "reopened" || event.event === "milestoned",
      );
      const writes =
        writeEvents.length === 0
          ? []
          : yield* recentWrites(
              repo,
              isoSeconds(Date.parse(writeEvents[0]!.created_at) - OWN_WRITE_WINDOW_MS),
            );
      const used = new Set(
        writes.length === 0
          ? []
          : (yield* sql<{ change_id: string; issue_number: number; kind: RecordedWrite["kind"] }>`
              SELECT change_id, issue_number, kind FROM issue_inbox_matched_writes
              WHERE change_id IN ${sql.in([...new Set(writes.map((write) => write.changeId))])}
            `).map((row) =>
              writeKey({ changeId: row.change_id, issueNumber: row.issue_number, kind: row.kind }),
            ),
      );
      const matched: RecordedWrite[] = [];
      let milestones: ReadonlyMap<string, number> | undefined;
      for (const event of newEvents) {
        const kind = EVENT_KINDS[event.event];
        const issue = event.issue!;
        if (kind === undefined || isBot(event.actor)) continue;
        if (kind === "labeled" && event.label != null && isReceiverLabel(event.label.name))
          continue;
        const candidates = writes.filter(
          (write) =>
            write.issueNumber === issue.number &&
            write.kind === kind &&
            !used.has(writeKey(write)) &&
            Math.abs(Date.parse(write.at) - Date.parse(event.created_at)) <= OWN_WRITE_WINDOW_MS,
        );
        if (kind === "milestoned" && candidates.length > 0 && milestones === undefined)
          milestones = new Map(
            (yield* readAll(repo, "milestones?state=all&per_page=100", decodeMilestones)).items.map(
              (milestone) => [milestone.title, milestone.number],
            ),
          );
        const destination =
          kind === "milestoned" && event.milestone != null
            ? milestones?.get(event.milestone.title)
            : undefined;
        const write = candidates.find(
          (candidate) => kind !== "milestoned" || candidate.milestoneNumber === destination,
        );
        if (write !== undefined) {
          used.add(writeKey(write));
          matched.push(write);
          continue;
        }
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

      /** The newest timestamp read, less the overlap; never earlier than the current cursor. */
      const advance = (cursor: string, stamps: ReadonlyArray<string>) => {
        const newest = stamps.reduce((max, stamp) => (stamp > max ? stamp : max), "");
        const next = newest === "" ? cursor : isoSeconds(Date.parse(newest) - CURSOR_OVERLAP_MS);
        return next > cursor ? next : cursor;
      };
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          let inserted = 0;
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
            inserted += rows.length;
          }
          for (const row of issueRows) yield* upsertIssue(repo, row);
          for (const write of matched)
            yield* sql`
              INSERT INTO issue_inbox_matched_writes (change_id, issue_number, kind)
              VALUES (${write.changeId}, ${write.issueNumber}, ${write.kind})
              ON CONFLICT DO NOTHING
            `;
          yield* sql`
            UPDATE issue_inbox_repositories SET
              issues_since = ${advance(
                state.issues_since,
                issuesRead.items.map((issue) => issue.updated_at),
              )},
              comments_since = ${advance(
                state.comments_since,
                commentsRead.items.map((comment) => comment.updated_at),
              )},
              events_after = ${Math.max(eventsAfter, ...eventsRead.items.map((event) => event.id))},
              issues_etag = ${issuesRead.etag},
              comments_etag = ${commentsRead.etag},
              events_etag = ${eventsRead.etag}
            WHERE host = ${repo.host} AND repository_id = ${repo.repositoryId}
          `;
          return inserted;
        }),
      );
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

  return { rest, ensureLabels, poll, enforceLabels };
});
