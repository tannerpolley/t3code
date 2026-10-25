/**
 * The cross-project issue inbox: records external GitHub issue activity for project repositories
 * (IssueInboxWatcher), registers a lead when marked work arrives, wakes it with digests, and backs
 * `t3_issue_post`, `t3_issue_inbox` and the inbox RPCs. Its own scheduler source polls.
 */
import {
  CommandId,
  IssueReadError,
  SourceControlProviderKind,
  IssueWorkError,
  MessageId,
  RepositoryIdentity,
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
  type ProjectId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import {
  EXTERNAL_LABEL,
  HIGH_PRIORITY_LABEL,
  digestText,
  fromLabel,
  DIGEST_INTERVAL_MS,
  digestEvent,
  projectSlug,
  sourceMarker,
} from "./IssueInboxRules.ts";
import { IssueWorkService } from "./IssueWorkService.ts";
import { IssueService } from "./IssueService.ts";
import * as Watcher from "./IssueInboxWatcher.ts";

const REGISTERED_POLL_INTERVAL_MS = 5 * 60_000;
const DISCOVERY_POLL_INTERVAL_MS = 15 * 60_000;
const sameRepositoryIdentity = Schema.toEquivalence(RepositoryIdentity);
const RawCreated = Schema.Struct({
  id: Schema.Number,
  number: Schema.optional(Schema.Number),
  html_url: Schema.String,
});
const decodeCreated = Schema.decodeUnknownEffect(Schema.fromJsonString(RawCreated));

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
    /** Polls repositories at their registered or discovery interval, then delivers due digests. */
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
      sourceProjectId?: ProjectId,
    ) => Effect.Effect<IssuePostResult, IssueWorkError | IssueReadError>;
  }
>()("t3/issues/IssueInbox") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectService;
  const issueWork = yield* IssueWorkService;
  const issues = yield* IssueService;
  const changes = yield* PubSub.sliding<void>(1);
  const deliveries = yield* KeyedLock.make<string>();
  const changed = PubSub.publish(changes, undefined);
  const watcher = yield* Watcher.make;
  const nowIso = Clock.currentTimeMillis.pipe(Effect.map(Watcher.isoSeconds));

  const registered = sql<{
    host: string;
    repository_id: string;
    repository: string;
    root_thread_id: string;
  }>`
    SELECT o.host, o.repository_id, o.repository, o.root_thread_id
    FROM orchestration_v2_projection_repository_orchestration o
    JOIN orchestration_v2_projection_threads t ON t.thread_id = o.root_thread_id
    WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND o.paused = 0
  `.pipe(
    Effect.map((rows) =>
      rows.map((row): Watcher.WatchedRepository => ({
        host: row.host,
        repositoryId: row.repository_id,
        repository: row.repository,
        rootThreadId: ThreadId.make(row.root_thread_id),
      })),
    ),
  );

  const discoveryIdentities = new Map<
    string,
    { identity: RepositoryIdentity; repository: Watcher.WatchedRepository }
  >();
  const watched = Effect.gen(function* () {
    const repositories = [...(yield* registered)];
    const shells = yield* projects.listShells();
    const current = new Set<string>(shells.map((project) => project.id));
    for (const id of discoveryIdentities.keys())
      if (!current.has(id)) discoveryIdentities.delete(id);
    for (const project of shells) {
      const identity = project.repositoryIdentity;
      const cached = discoveryIdentities.get(project.id);
      const unchanged =
        cached !== undefined &&
        identity != null &&
        sameRepositoryIdentity(cached.identity, identity);
      if (!unchanged) discoveryIdentities.delete(project.id);
      if (identity?.provider !== "github") continue;
      const host = sourceControlDefinitions
        .changeRequestHost(identity, SourceControlProviderKind.make("github"))
        .toLowerCase();
      const repository =
        identity.origin?.displayName ?? sourceControlDefinitions.repositorySelector(identity);
      if (
        repository === null ||
        repositories.some(
          (repo) =>
            repo.host === host && repo.repository.toLowerCase() === repository.toLowerCase(),
        )
      )
        continue;
      // A paused or archived owner must not be replaced or woken by Inbox discovery.
      if ((yield* issueWork.repositoryStatus({ host, repository })).rootThreadId !== null) continue;
      if (cached !== undefined && unchanged) {
        repositories.push(cached.repository);
        continue;
      }
      yield* issues.repositoryIdentity({ host, repository }).pipe(
        Effect.tap((repo) =>
          Effect.sync(() => {
            const watchedRepository = { ...repo, rootThreadId: null };
            discoveryIdentities.set(project.id, {
              identity,
              repository: watchedRepository,
            });
            repositories.push(watchedRepository);
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Issue inbox repository discovery failed", { repository, cause }),
        ),
      );
    }
    return repositories;
  });

  // Serialize retries through dispatch too: a pending row must not be sent by overlapping polls.
  const deliverDigest = Effect.fn("IssueInbox.deliverDigest")(
    function* (repo: Watcher.WatchedRepository) {
      if (repo.rootThreadId === null) return;
      const [digest] = yield* sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const cutoff = DateTime.formatIso(DateTime.makeUnsafe(now - DIGEST_INTERVAL_MS));
          const [recent] = yield* sql`
          SELECT digest_id FROM issue_inbox_digests
          WHERE host = ${repo.host} AND repository_id = ${repo.repositoryId}
            AND julianday(delivered_at) > julianday(${cutoff})
          LIMIT 1
        `;
          if (recent !== undefined) return [];
          const pending = yield* sql<{ digest_id: number }>`
          SELECT digest_id FROM issue_inbox_digests
          WHERE host = ${repo.host} AND repository_id = ${repo.repositoryId} AND delivered_at IS NULL
        `;
          if (pending.length > 0) return pending;
          const tagged = yield* sql<EventRow>`
          SELECT * FROM issue_inbox_events
          WHERE host = ${repo.host} AND repository_id = ${repo.repositoryId}
            AND read_at IS NULL AND digest_id IS NULL AND tagged = 1
          ORDER BY high_priority DESC, event_id
        `;
          if (tagged.length === 0) return [];
          const since = tagged.reduce(
            (min, event) => (event.occurred_at < min ? event.occurred_at : min),
            tagged[0]!.occurred_at,
          );
          const text = digestText(tagged.map(digestEvent), since);
          const rows = yield* sql<{ digest_id: number }>`
          INSERT INTO issue_inbox_digests (host, repository_id, text, created_at)
          VALUES (${repo.host}, ${repo.repositoryId}, ${text}, ${Watcher.isoSeconds(now)})
          RETURNING digest_id
        `;
          yield* sql`
          UPDATE issue_inbox_events SET digest_id = ${rows[0]!.digest_id}
          WHERE event_id IN ${sql.in(tagged.map((event) => event.event_id))}
        `;
          return rows;
        }),
      );
      if (digest === undefined) return;
      const id = `issue-inbox-digest:${digest.digest_id}:${repo.rootThreadId}`;
      const unread = yield* sql<EventRow>`
        SELECT * FROM issue_inbox_events
        WHERE digest_id = ${digest.digest_id} AND read_at IS NULL
        ORDER BY high_priority DESC, event_id
      `;
      if (unread.length === 0) {
        // A crash after the queue accepted this digest, before delivered_at, still started the cooldown.
        const [accepted] = yield* sql<{ accepted_at: string }>`
          SELECT accepted_at FROM orchestration_command_receipts
          WHERE command_id = ${id} AND status = 'accepted'
        `;
        yield* accepted === undefined
          ? sql`DELETE FROM issue_inbox_digests WHERE digest_id = ${digest.digest_id}`
          : sql`UPDATE issue_inbox_digests SET delivered_at = ${accepted.accepted_at}
              WHERE digest_id = ${digest.digest_id}`;
        return;
      }
      const since = unread.reduce(
        (min, event) => (event.occurred_at < min ? event.occurred_at : min),
        unread[0]!.occurred_at,
      );
      const text = digestText(unread.map(digestEvent), since);
      // Queued, never steered: Claude's steering interrupts running tools. Idle, it starts a turn.
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId: repo.rootThreadId,
        messageId: MessageId.make(id),
        text,
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: "Tagged external issue activity",
          detail: text,
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      yield* sql`
        UPDATE issue_inbox_digests SET delivered_at = ${DateTime.formatIso(yield* DateTime.now)}
        WHERE digest_id = ${digest.digest_id}
      `;
      return;
    },
    (effect, repo) => deliveries.withLock(`${repo.host}/${repo.repositoryId}`, effect),
  );

  const lastPolledAt = new Map<string, number>();
  const pollDue = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const repositories = yield* watched;
    const current = new Set(repositories.map((repo) => `${repo.host}/${repo.repositoryId}`));
    for (const key of lastPolledAt.keys()) if (!current.has(key)) lastPolledAt.delete(key);
    for (let repo of repositories) {
      const key = `${repo.host}/${repo.repositoryId}`;
      const lastPoll = lastPolledAt.get(key);
      const interval =
        repo.rootThreadId === null ? DISCOVERY_POLL_INTERVAL_MS : REGISTERED_POLL_INTERVAL_MS;
      if (lastPoll !== undefined && now < lastPoll + interval) continue;
      lastPolledAt.set(key, now);
      yield* Effect.gen(function* () {
        if ((yield* watcher.poll(repo)) > 0) yield* changed;
        if (repo.rootThreadId === null) {
          const [pending] = yield* sql`SELECT event_id FROM issue_inbox_events
            WHERE host = ${repo.host} AND repository_id = ${repo.repositoryId} AND tagged = 1 AND read_at IS NULL LIMIT 1`;
          if (pending !== undefined) {
            const registered = yield* issueWork.ensureOrchestrator(repo);
            repo = { ...repo, rootThreadId: registered.rootThreadId };
            if (repo.rootThreadId !== null) yield* changed;
          }
        }
        yield* watcher.enforceLabels(repo);
      }).pipe(
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

  const markRead = Effect.fn("IssueInbox.markRead")(function* (input: IssueInboxMarkReadInput) {
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
    NodeSqliteClient.readOnly,
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

  const callerRepository = Effect.fn("IssueInbox.callerRepository")(function* (
    callerThreadId: ThreadId,
  ) {
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

  const forCaller: IssueInbox["Service"]["forCaller"] = Effect.fn("IssueInbox.forCaller")(
    function* (callerThreadId, input) {
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
    },
    Effect.mapError((cause) => (isIssueWorkError(cause) ? cause : storageError(cause))),
  );

  const post: IssueInbox["Service"]["post"] = Effect.fn("IssueInbox.post")(
    function* (callerThreadId, input, sourceProjectId) {
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
      // Durable server work retains its source project after the requesting thread is deleted.
      const projectId = shell?.projectId ?? sourceProjectId;
      if (projectId === undefined)
        return yield* new IssueWorkError({
          code: "invalid-request",
          message: "The calling thread is unavailable.",
        });
      const project = Option.getOrNull(
        yield* projects.getById(projectId).pipe(Effect.mapError(storageError)),
      );
      const identity = project?.repositoryIdentity ?? null;
      if (identity === null)
        return yield* new IssueWorkError({
          code: "orchestration-error",
          message: "The project's repository identity is unavailable; retry.",
        });
      const own = [
        identity?.origin?.displayName,
        sourceControlDefinitions.repositorySelector(identity),
      ].flatMap((name) => (name == null ? [] : [name.toLowerCase()]));
      const ownHost =
        identity === null
          ? null
          : sourceControlDefinitions
              .changeRequestHost(identity, SourceControlProviderKind.make("github"))
              .toLowerCase();
      const crossProject = !(
        identity?.provider === "github" &&
        ownHost === target.host &&
        own.includes(target.repository)
      );
      const projectName = projectSlug(
        own[0]?.slice(own[0].indexOf("/") + 1) ?? project?.title ?? "project",
      );
      const labels = crossProject
        ? [EXTERNAL_LABEL, fromLabel(projectName), HIGH_PRIORITY_LABEL]
        : [];
      const body = crossProject
        ? `${input.body}\n\n${sourceMarker({
            project: projectName,
            repository: own[0] === undefined || ownHost === null ? null : `${ownHost}/${own[0]}`,
            thread: callerThreadId,
          })}`
        : input.body;
      if (labels.length > 0) yield* watcher.ensureLabels(target, labels);
      const response =
        input.issueNumber === undefined
          ? yield* watcher.rest(target, "issues", {
              body: { title: input.title, body, ...(labels.length > 0 ? { labels } : {}) },
            })
          : yield* watcher.rest(target, `issues/${input.issueNumber}/comments`, {
              body: { body },
            });
      // A cross-project comment marks the issue it lands on as external too.
      if (input.issueNumber !== undefined && labels.length > 0)
        yield* watcher.rest(target, `issues/${input.issueNumber}/labels`, { body: { labels } });
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
      return {
        url: created.html_url,
        issueNumber,
        commentId: input.issueNumber === undefined ? null : String(created.id),
        crossProject,
        labels,
      };
    },
    Effect.mapError((cause) =>
      isIssueWorkError(cause) || isIssueReadError(cause) ? cause : storageError(cause),
    ),
  );

  return IssueInbox.of({
    pollDue,
    list: Effect.fn("IssueInbox.list")(
      function* (input) {
        const events = yield* unreadEvents(input);
        const pending = yield* sql<{ issue_number: number }>`
        SELECT issue_number FROM issue_inbox_events
        WHERE host = ${input.host.toLowerCase()}
          AND lower(repository) = ${input.repository.toLowerCase()}
          AND kind = 'issue_opened' AND read_at IS NULL
      `;
        return { events, pendingIssueNumbers: pending.map((row) => row.issue_number) };
      },
      (reads) => sql.withTransaction(reads).pipe(NodeSqliteClient.readOnly),
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

export const layer = Layer.effect(
  IssueInbox,
  Effect.gen(function* () {
    const inbox = yield* make;
    // Its own serialized source, so slow GitHub reads never hold up repository issue work.
    const scheduler = yield* Effect.serviceOption(Scheduler.Scheduler);
    if (Option.isSome(scheduler)) yield* scheduler.value.register("issue-inbox", inbox.pollDue);
    return inbox;
  }),
);
