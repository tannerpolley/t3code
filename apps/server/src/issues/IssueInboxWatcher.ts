/**
 * Reads one managed repository's new issues, new comments and issue events since its cursors and
 * records the external part in the inbox tables. Body edits are not tracked. Conditional page-1
 * reads keep an unchanged repository free.
 */
import type { IssueInboxEventKind, ThreadId } from "@t3tools/contracts";
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
  foreignMarker,
  fromLabel,
  hasLabel,
  isBot,
  isReceiverLabel,
  isTagged,
  snippet,
  type WriteTransition,
} from "./IssueInboxRules.ts";

/** Timestamp cursors re-read this much, so same-second and late-committed writes are not lost. */
const CURSOR_OVERLAP_MS = 5 * 60_000;
/** Clock slack around a recorded T3 write's request when matching the event GitHub logged. */
const RECEIPT_SLACK_MS = 5_000;
/** Pages per listing per poll; a longer catch-up skips ahead and leaves one missed-activity note. */
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
  rename: Schema.optional(Schema.NullOr(Schema.Struct({ from: Schema.String, to: Schema.String }))),
  issue: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        number: Schema.Number,
        title: Schema.String,
        body: Schema.optional(Schema.NullOr(Schema.String)),
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
  unlabeled: "unlabeled",
  milestoned: "milestoned",
  demilestoned: "demilestoned",
  renamed: "renamed",
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
  readonly cross_project: number;
  readonly external_source: string | null;
  readonly labeled: number;
}

interface ReceiptRow {
  readonly receipt_id: number;
  readonly issue_number: number;
  readonly kind: WriteTransition["kind"];
  readonly milestone_number: number | null;
  readonly started_at: number;
  readonly finished_at: number;
}

/** The labels an issue from another project gets, naming that project. */
const receiverLabels = (source: string) => [EXTERNAL_LABEL, HIGH_PRIORITY_LABEL, fromLabel(source)];

// GitHub's own timestamp shape, so cursors compare as strings with GitHub's.
export const isoSeconds = (millis: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(millis)).replace(/\.\d{3}Z$/u, "Z");

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
   * A listing's pages, newest first: a 304 on page 1 means nothing changed. Reading stops once
   * `enough` sees items already handled, or at MAX_PAGES with `complete: false`.
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

  /** Starts watching from now: history from before is not news. */
  const initialize = (repo: WatchedRepository) =>
    Effect.gen(function* () {
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
      const ownWrites = new Set(
        (yield* sql<{ item: string }>`
          SELECT item FROM issue_inbox_own_writes
          WHERE host = ${repo.host} AND repository = ${repo.repository.toLowerCase()}
        `).map((row) => row.item),
      );
      const inserts: NewEvent[] = [];
      const issueRows = new Map<number, IssueRow>();
      // Classifies an issue as another project's once, from the marker its opening or body carries,
      // and makes it due for any missing receiver labels then. An issue someone opened by hand is
      // external activity but names no project, so it gets no labels. Later removals stay removed.
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
                ownRecord: ownWrites.has(`issue:${issue.number}`),
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
          tagged: isTagged({ body, labels, marked: origin.marked }),
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
          ownRecord: ownWrites.has(`comment:${comment.id}`),
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
          sourceProject: origin.sourceProject ?? (externalSource(comment.number) || null),
          tagged: isTagged({ body, labels, marked: origin.marked }),
          highPriority: highPriority(comment.number, labels),
          needsTriage: false,
          url: comment.html_url,
          snippet: snippet(body),
          occurredAt: comment.created_at,
        });
      }

      // A state or milestone event is T3's own only when it falls inside the request span of an
      // unused receipt for the same transition on the same issue. Each receipt explains one event.
      const transitionEvents = newEvents.filter(
        (event) =>
          event.event === "closed" ||
          event.event === "reopened" ||
          event.event === "milestoned" ||
          event.event === "demilestoned",
      );
      const receipts: ReceiptRow[] =
        transitionEvents.length === 0
          ? []
          : [
              ...(yield* sql<ReceiptRow>`
                SELECT receipt_id, issue_number, kind, milestone_number, started_at, finished_at
                FROM issue_inbox_write_receipts
                WHERE host = ${repo.host.toLowerCase()}
                  AND repository = ${repo.repository.toLowerCase()}
                  AND issue_number IN ${sql.in([...new Set(transitionEvents.map((event) => event.issue!.number))])}
              `),
            ];
      const usedReceipts: number[] = [];
      let milestones: ReadonlyMap<string, number> | undefined;
      for (const event of newEvents) {
        const kind = EVENT_KINDS[event.event];
        const issue = event.issue!;
        if (kind === undefined || isBot(event.actor)) continue;
        if (
          (kind === "labeled" || kind === "unlabeled") &&
          event.label != null &&
          isReceiverLabel(event.label.name)
        )
          continue;
        const labels = issue.labels?.map((label) => label.name) ?? [];
        const body = listed.get(issue.number)?.body ?? issue.body ?? "";
        noteIssue({ ...issue, body }, labels, null);
        const at = Date.parse(event.created_at);
        const candidates = receipts.filter(
          (receipt) =>
            receipt.issue_number === issue.number &&
            receipt.kind === kind &&
            !usedReceipts.includes(receipt.receipt_id) &&
            at >= receipt.started_at - RECEIPT_SLACK_MS &&
            at <= receipt.finished_at + RECEIPT_SLACK_MS,
        );
        const milestoned = kind === "milestoned" || kind === "demilestoned";
        if (milestoned && candidates.length > 0 && milestones === undefined)
          milestones = new Map(
            (yield* readAll(repo, "milestones?state=all&per_page=100", decodeMilestones)).items.map(
              (milestone) => [milestone.title, milestone.number],
            ),
          );
        const milestoneNumber =
          milestoned && event.milestone != null ? milestones?.get(event.milestone.title) : null;
        const receipt = candidates.find(
          (candidate) => !milestoned || candidate.milestone_number === milestoneNumber,
        );
        if (receipt !== undefined) {
          usedReceipts.push(receipt.receipt_id);
          continue;
        }
        inserts.push({
          key: `event:${event.id}`,
          kind,
          issueNumber: issue.number,
          issueTitle: issue.title,
          author: event.actor?.login ?? null,
          sourceProject: externalSource(issue.number) || null,
          tagged:
            isTagged({ body, labels, marked: foreignMarker(body, repositoryKey) !== null }) ||
            event.label?.name.toLowerCase() === CROSS_PROJECT_LABEL,
          highPriority: highPriority(issue.number, labels),
          needsTriage: false,
          url: issue.html_url,
          snippet:
            (kind === "labeled" || kind === "unlabeled") && event.label != null
              ? `Label: ${event.label.name}`
              : milestoned && event.milestone != null
                ? `Milestone: ${event.milestone.title}`
                : kind === "renamed" && event.rename != null
                  ? `Renamed from "${event.rename.from}" to "${event.rename.to}"`
                  : "",
          occurredAt: event.created_at,
        });
      }

      // Never stall: a catch-up past the page cap skips to the newest activity read and says so.
      if (!issuesRead.complete || !commentsRead.complete || !eventsRead.complete) {
        const now = isoSeconds(yield* Clock.currentTimeMillis);
        inserts.push({
          key: `missed:${now}`,
          kind: "missed_activity",
          issueNumber: 0,
          issueTitle: "Missed issue activity",
          author: null,
          sourceProject: null,
          tagged: true,
          highPriority: true,
          needsTriage: false,
          url: `https://${repo.host}/${repo.repository}/issues`,
          snippet: "Missed some issue activity while T3 was offline; check GitHub.",
          occurredAt: now,
        });
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
          if (usedReceipts.length > 0)
            yield* sql`
              DELETE FROM issue_inbox_write_receipts WHERE receipt_id IN ${sql.in(usedReceipts)}
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
  const enforceLabels = (repo: WatchedRepository) =>
    Effect.gen(function* () {
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
