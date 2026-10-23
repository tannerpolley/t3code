/**
 * Reads one managed repository's new issues, new comments and issue events since its cursors and
 * records the external part in the inbox tables. Body edits are not tracked. Conditional page-1
 * reads keep an unchanged repository free.
 */
import { CommandId, type IssueInboxEventKind, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { readIssueQueue } from "./IssueQueueStore.ts";
import { IssueService } from "./IssueService.ts";
import {
  CROSS_PROJECT_LABEL,
  EXTERNAL_LABEL,
  HIGH_PRIORITY_LABEL,
  classifyWrite,
  foreignMarker,
  fromLabel,
  hasLabel,
  snippet,
} from "./IssueInboxRules.ts";

/** Timestamp cursors re-read this much, so same-second and late-committed writes are not lost. */
const CURSOR_OVERLAP_MS = 5 * 60_000;
/** Pages per listing per poll; longer catch-ups skip ahead. */
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
  number: Schema.Number,
  title: Schema.String,
  state: Schema.optional(Schema.Literals(["open", "closed"])),
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
  created_at: Schema.String,
  issue: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        number: Schema.Number,
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
export interface WatchedRepository {
  readonly host: string;
  readonly repositoryId: string;
  readonly repository: string;
  readonly rootThreadId: ThreadId | null;
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
  readonly cross_project: number;
  readonly external_source: string | null;
  readonly labeled: number;
}

/** The labels an issue from another project gets, naming that project. */
const receiverLabels = (source: string) => [EXTERNAL_LABEL, HIGH_PRIORITY_LABEL, fromLabel(source)];

// GitHub's own timestamp shape, so cursors compare as strings with GitHub's.
export const isoSeconds = (millis: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(millis)).replace(/\.\d{3}Z$/u, "Z");

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const issues = yield* IssueService;
  const threads = yield* ThreadManagementService;

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
   * A listing's pages, newest first: a 304 on page 1 means nothing changed. Reading stops once
   * `enough` sees items already handled, or at MAX_PAGES with `complete: false`.
   */
  const readAll = Effect.fn("IssueInboxWatcher.readAll")(function* <A, E>(
    repo: WatchedRepository,
    path: string,
    decode: (body: string) => Effect.Effect<ReadonlyArray<A>, E>,
    etag: string | null = null,
    enough: (items: ReadonlyArray<A>) => boolean = () => false,
  ) {
    const first = yield* rest(repo, `${path}&page=1`, { etag });
    if (first.status === 304) return { items: [] as ReadonlyArray<A>, etag, complete: true };
    const items = [...(yield* decode(first.body))];
    let next = first.nextPage;
    for (let pages = 1; next !== null && !enough(items); pages++) {
      if (pages >= MAX_PAGES) return { items, etag: first.etag, complete: false };
      const page = yield* rest(repo, `${path}&page=${next}`);
      items.push(...(yield* decode(page.body)));
      next = page.nextPage;
    }
    return { items: items as ReadonlyArray<A>, etag: first.etag, complete: true };
  });

  /** Creates the labels a repository lacks, with T3's colors. */
  const ensureLabels = Effect.fn("IssueInboxWatcher.ensureLabels")(function* (
    repo: Pick<WatchedRepository, "host" | "repository">,
    names: ReadonlyArray<string>,
  ) {
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

  /** Starts watching from now: history from before is not news. */
  const initialize = Effect.fn("IssueInboxWatcher.initialize")(function* (repo: WatchedRepository) {
    const startedAt = yield* Clock.currentTimeMillis;
    const events = yield* rest(repo, `${EVENTS_PATH}&page=1`);
    const latest = Math.max(0, ...(yield* decodeEvents(events.body)).map((event) => event.id));
    const cursor = isoSeconds(startedAt - CURSOR_OVERLAP_MS);
    yield* sql`
        INSERT INTO issue_inbox_repositories (host, repository_id, watched_since, issues_since,
          comments_since, events_after, events_etag)
        VALUES (${repo.host}, ${repo.repositoryId}, ${isoSeconds(startedAt)}, ${cursor},
          ${cursor}, ${latest}, ${events.etag})
        ON CONFLICT DO NOTHING
      `;
    return 0;
  });

  /** Polls one repository and returns how many new inbox events it recorded. */
  const poll = Effect.fn("IssueInboxWatcher.poll")(function* (repo: WatchedRepository) {
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
        comment.created_at >= state.watched_since
        ? [{ ...comment, number }]
        : [];
    });
    const newEvents = eventsRead.items.filter(
      (event) =>
        event.id > eventsAfter && event.issue != null && event.issue.pull_request === undefined,
    );
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
              SELECT issue_number, title, cross_project, external_source, labeled
              FROM issue_inbox_issues
              WHERE host = ${repo.host} AND repository_id = ${repo.repositoryId}
                AND issue_number IN ${sql.in(numbers)}
            `).map((row) => [row.issue_number, row]),
    );
    const inserts: NewEvent[] = [];
    const issueRows = new Map<number, IssueRow>();
    // Classifies an issue as another project's once, from the marker its opening or body carries,
    // and makes it due for missing receiver labels. Later removals stay removed.
    const noteIssue = (
      issue: {
        readonly number: number;
        readonly title: string;
        readonly body?: string | null | undefined;
      },
      labels: ReadonlyArray<string>,
      openedExternally: { readonly sourceProject: string | null } | null,
    ) => {
      const previous = issueRows.get(issue.number) ?? known.get(issue.number);
      const marker = foreignMarker(issue.body ?? "", repositoryKey);
      const source =
        previous?.external_source ?? openedExternally?.sourceProject ?? marker?.project ?? null;
      issueRows.set(issue.number, {
        issue_number: issue.number,
        title: issue.title,
        cross_project: hasLabel(labels, CROSS_PROJECT_LABEL) ? 1 : 0,
        external_source: source,
        labeled:
          previous?.external_source != null
            ? previous.labeled
            : source !== null &&
                !receiverLabels(source).every((label) => hasLabel(labels, label.toLowerCase()))
              ? 0
              : 1,
      });
    };
    const externalSource = (number: number) =>
      (issueRows.get(number) ?? known.get(number))?.external_source ?? null;
    const highPriority = (number: number, labels: ReadonlyArray<string>) =>
      hasLabel(labels, HIGH_PRIORITY_LABEL) || externalSource(number) !== null;

    for (const issue of issueList) {
      const body = issue.body ?? "";
      const labels = issue.labels?.map((label) => label.name) ?? [];
      const origin =
        issue.created_at >= state.watched_since
          ? classifyWrite({
              body,
              author: issue.user,
              repositoryKey,
            })
          : null;
      noteIssue(issue, labels, origin?.origin === "external" ? origin : null);
      if (origin?.origin !== "external") continue;
      inserts.push({
        key: `opened:${issue.number}`,
        kind: "issue_opened",
        issueNumber: issue.number,
        issueTitle: issue.title,
        author: issue.user?.login ?? null,
        sourceProject: origin.sourceProject,
        tagged: true,
        highPriority: true,
        needsTriage: issue.milestone == null,
        url: issue.html_url,
        snippet: snippet(body),
        occurredAt: issue.created_at,
      });
    }

    for (const comment of comments) {
      const body = comment.body ?? "";
      const origin = classifyWrite({
        body,
        author: comment.user,
        repositoryKey,
      });
      if (origin.origin !== "external") continue;
      const issue = listed.get(comment.number);
      const labels =
        issue?.labels?.map((label) => label.name) ??
        ((issueRows.get(comment.number) ?? known.get(comment.number))?.cross_project === 1
          ? [CROSS_PROJECT_LABEL]
          : []);
      inserts.push({
        key: `comment:${comment.id}`,
        kind: "comment",
        issueNumber: comment.number,
        issueTitle: issue?.title ?? known.get(comment.number)?.title ?? "",
        author: comment.user?.login ?? null,
        sourceProject: origin.sourceProject,
        tagged: true,
        highPriority: highPriority(comment.number, labels),
        needsTriage: false,
        url: comment.html_url,
        snippet: snippet(body),
        occurredAt: comment.created_at,
      });
    }

    // Queue cleanup uses all observed transitions, including T3's own and bot closes.
    // Dispatch before advancing cursors so a failed removal is retried on the next poll.
    const states = new Map<number, { state: "open" | "closed"; at: string }>();
    for (const event of newEvents.toSorted((a, b) => a.id - b.id)) {
      if (event.event === "closed" || event.event === "reopened")
        states.set(event.issue!.number, {
          state: event.event === "closed" ? "closed" : "open",
          at: event.created_at,
        });
    }
    for (const issue of issueList) {
      if (issue.state !== undefined && issue.updated_at > (states.get(issue.number)?.at ?? ""))
        states.set(issue.number, { state: issue.state, at: issue.updated_at });
    }
    if ([...states.values()].some(({ state }) => state === "closed")) {
      for (const entry of yield* readIssueQueue(repo).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      )) {
        if (states.get(entry.issue.number)?.state !== "closed") continue;
        yield* threads.dispatch({
          type: "issue.queue.change",
          // Keyed by the current root too: a removal rejected during a root change gets a
          // fresh command under the new root instead of replaying that rejection forever.
          commandId: CommandId.make(
            `issue-inbox-closed:${repo.host}:${repo.repositoryId}:${repo.rootThreadId}:${entry.requestId}`,
          ),
          threadId:
            repo.rootThreadId ?? ThreadId.make(`issue-queue:${repo.host}:${repo.repositoryId}`),
          issue: entry.issue,
          queued: false,
        });
      }
    }

    /**
     * The newest timestamp read, less the overlap; never earlier than the current cursor. After
     * an overflow the cursor stops at the newest read itself, so the abandoned backlog, even one
     * inside the overlap, is never walked or reported again.
     */
    const advance = (cursor: string, stamps: ReadonlyArray<string>, complete: boolean) => {
      const newest = stamps.reduce((max, stamp) => (stamp > max ? stamp : max), "");
      const next =
        newest === "" || !complete ? newest : isoSeconds(Date.parse(newest) - CURSOR_OVERLAP_MS);
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
        for (const row of issueRows.values())
          yield* sql`
              INSERT INTO issue_inbox_issues (host, repository_id, issue_number, title,
                cross_project, external_source, labeled)
              VALUES (${repo.host}, ${repo.repositoryId}, ${row.issue_number}, ${row.title},
                ${row.cross_project}, ${row.external_source}, ${row.labeled})
              ON CONFLICT (host, repository_id, issue_number) DO UPDATE SET
                title = excluded.title, cross_project = excluded.cross_project,
                external_source = excluded.external_source, labeled = excluded.labeled
            `;
        yield* sql`
            UPDATE issue_inbox_repositories SET
              issues_since = ${advance(
                state.issues_since,
                issuesRead.items.map((issue) => issue.updated_at),
                issuesRead.complete,
              )},
              comments_since = ${advance(
                state.comments_since,
                commentsRead.items.map((comment) => comment.updated_at),
                commentsRead.complete,
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
  const enforceLabels = Effect.fn("IssueInboxWatcher.enforceLabels")(function* (
    repo: WatchedRepository,
  ) {
    const pending = yield* sql<{ issue_number: number; external_source: string }>`
        SELECT issue_number, external_source FROM issue_inbox_issues
        WHERE host = ${repo.host} AND repository_id = ${repo.repositoryId}
          AND external_source IS NOT NULL AND external_source <> '' AND labeled = 0
      `;
    for (const row of pending) {
      const labels = receiverLabels(row.external_source);
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
