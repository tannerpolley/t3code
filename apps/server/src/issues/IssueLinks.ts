import {
  IssueLinkError,
  IssueRef,
  type IssueLinkInput,
  type IssueLinkResult,
  type IssueListResult,
  type IssueSummary,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { runtimeRequestNeedsUser } from "@t3tools/provider-core/server/subagentProjection";
import { threadPullRequestsOf } from "@t3tools/shared/threadPullRequests";

const key = (issue: IssueRef) =>
  `${issue.host.toLowerCase()}/${issue.repository.toLowerCase()}#${issue.number}`;
const isIssueRef = Schema.is(IssueRef);
const encodePrRefs = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(IssueRef)));
const storageError = (cause: unknown) => new IssueLinkError({ code: "storage", cause });

function target(input: IssueLinkInput): IssueRef | null {
  let ref = {
    host: input.host ?? "github.com",
    repository: input.repository,
    number: input.number,
  };
  if (input.url !== undefined) {
    try {
      const url = new URL(input.url);
      const match = /^\/([^/]+\/[^/]+)\/issues\/(\d+)\/?$/.exec(url.pathname);
      if (url.protocol !== "https:" || url.username || url.password || url.port || match === null)
        return null;
      ref = { host: url.hostname, repository: match[1], number: Number(match[2]) };
      if (
        (input.host !== undefined && input.host.toLowerCase() !== ref.host.toLowerCase()) ||
        (input.repository !== undefined &&
          input.repository.toLowerCase() !== ref.repository?.toLowerCase()) ||
        (input.number !== undefined && input.number !== ref.number)
      )
        return null;
    } catch {
      return null;
    }
  }
  return isIssueRef(ref)
    ? { ...ref, host: ref.host.toLowerCase(), repository: ref.repository.toLowerCase() }
    : null;
}

/** Ordinary thread associations, independent of repository orchestration ownership. */
export class IssueLinks extends Context.Service<
  IssueLinks,
  {
    readonly link: (
      input: IssueLinkInput,
      callerThreadId?: ThreadId,
      remove?: boolean,
    ) => Effect.Effect<IssueLinkResult, IssueLinkError>;
    readonly enrich: (list: IssueListResult) => Effect.Effect<IssueListResult, IssueLinkError>;
  }
>()("t3/issues/IssueLinks") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const link: IssueLinks["Service"]["link"] = Effect.fn("IssueLinks.link")(function* (
    input,
    callerThreadId,
    remove = false,
  ) {
    const issue = target(input);
    const threadId = input.threadId ?? callerThreadId;
    if (issue === null || threadId === undefined)
      return yield* new IssueLinkError({ code: "invalid-request" });
    const thread = yield* projections.getThreadShell(threadId).pipe(Effect.mapError(storageError));
    if (thread === null || thread.deletedAt !== null)
      return yield* new IssueLinkError({ code: "thread-not-found" });
    const rows = yield* (
      remove
        ? sql`DELETE FROM issue_thread_links WHERE host = ${issue.host} AND repository = ${issue.repository}
          AND issue_number = ${issue.number} AND thread_id = ${threadId} RETURNING thread_id`
        : sql`INSERT INTO issue_thread_links(host, repository, issue_number, thread_id)
          VALUES (${issue.host}, ${issue.repository}, ${issue.number}, ${threadId})
          ON CONFLICT DO NOTHING RETURNING thread_id`
    ).pipe(Effect.mapError(storageError));
    return { issue, threadId, changed: rows.length > 0 };
  });
  const enrich: IssueLinks["Service"]["enrich"] = Effect.fn("IssueLinks.enrich")(function* (list) {
    const host = list.repository.host.toLowerCase();
    const repository = list.repository.repository.toLowerCase();
    const rows = yield* sql<{ issue_number: number; thread_id: string }>`
      SELECT issue_number, thread_id FROM issue_thread_links
      WHERE host = ${host} AND repository = ${repository}
    `.pipe(Effect.mapError(storageError));
    const issueNumbers = list.issues.map((issue) => issue.number);
    const prRefs = list.issues.flatMap((issue) => issue.pullRequestRefs ?? []);
    const prRefsJson = yield* encodePrRefs(prRefs).pipe(Effect.mapError(storageError));
    // Only candidate IDs and their descendants leave SQLite. Shell decoding and activity reads
    // are restricted to those threads, rather than the environment's entire active snapshot.
    const candidates =
      issueNumbers.length === 0
        ? []
        : yield* sql<{ thread_id: string }>`
      WITH RECURSIVE linked(thread_id) AS (
        SELECT t.thread_id FROM orchestration_v2_projection_threads t
        WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND (
          t.thread_id IN ${sql.in(rows.filter((row) => issueNumbers.includes(row.issue_number)).map((row) => row.thread_id))}
          OR (
            lower(json_extract(t.payload_json, '$.linkedIssue.host')) = ${host}
            AND lower(json_extract(t.payload_json, '$.linkedIssue.repository')) = ${repository}
            AND json_extract(t.payload_json, '$.linkedIssue.number') IN ${sql.in(issueNumbers)}
          )
          ${
            prRefs.length === 0
              ? sql``
              : sql`OR EXISTS (
            SELECT 1 FROM json_each(t.payload_json, '$.pullRequests') pr
            JOIN json_each(${prRefsJson}) ref
              ON lower(json_extract(pr.value, '$.host')) = lower(json_extract(ref.value, '$.host'))
              AND lower(json_extract(pr.value, '$.repository')) = lower(json_extract(ref.value, '$.repository'))
              AND json_extract(pr.value, '$.number') = json_extract(ref.value, '$.number')
            WHERE json_extract(pr.value, '$.source') IS NOT 'stack-dismissed'
          ) OR (
            json_extract(t.payload_json, '$.pullRequests') IS NULL AND EXISTS (
              SELECT 1 FROM json_each(${prRefsJson}) ref
              WHERE lower(json_extract(t.payload_json, '$.linkedPullRequest.repository')) = lower(json_extract(ref.value, '$.repository'))
                AND lower(json_extract(t.payload_json, '$.linkedPullRequest.url')) LIKE 'https://' || lower(json_extract(ref.value, '$.host')) || '/%'
                AND json_extract(t.payload_json, '$.linkedPullRequest.number') = json_extract(ref.value, '$.number')
            )
          )`
          }
        )
        UNION
        SELECT child.thread_id FROM orchestration_v2_projection_threads child
        JOIN linked ON json_extract(child.payload_json, '$.lineage.parentThreadId') = linked.thread_id
        WHERE child.deleted_at IS NULL AND child.archived_at IS NULL
      )
      SELECT thread_id FROM linked ORDER BY thread_id
    `.pipe(Effect.mapError(storageError));
    const shells = yield* Effect.forEach(candidates, ({ thread_id }) =>
      projections.getThreadShell(ThreadId.make(thread_id)),
    ).pipe(Effect.mapError(storageError));
    const threads = shells
      .filter((thread) => thread !== null)
      .filter((thread) => thread.deletedAt === null && thread.archivedAt === null);
    const issues = new Map(
      list.issues.map((issue) => [key({ ...list.repository, number: issue.number }), issue.number]),
    );
    const refsByThread = new Map<string, Set<number>>();
    const add = (threadId: string, number: number) => {
      const refs = refsByThread.get(threadId) ?? new Set<number>();
      refs.add(number);
      refsByThread.set(threadId, refs);
    };
    for (const row of rows) add(row.thread_id, row.issue_number);
    const issuesByPr = new Map<string, Set<number>>();
    for (const issue of list.issues)
      for (const pr of issue.pullRequestRefs ?? []) {
        const refs = issuesByPr.get(key(pr)) ?? new Set<number>();
        refs.add(issue.number);
        issuesByPr.set(key(pr), refs);
      }
    for (const thread of threads) {
      if (thread.linkedIssue !== undefined) {
        const number = issues.get(key(thread.linkedIssue));
        if (number !== undefined) add(thread.id, number);
      }
      for (const pr of threadPullRequestsOf(thread)) {
        if (pr.source === "stack-dismissed") continue;
        for (const number of issuesByPr.get(key(pr)) ?? []) add(thread.id, number);
      }
    }
    // Delegated and native child shells inherit associations from their ancestors. A visited set
    // bounds corrupt lineage; each selected shell is read once, never per issue.
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const work = new Map<number, NonNullable<IssueSummary["liveWork"]>[number][]>();
    for (const thread of threads) {
      const refs = new Set(refsByThread.get(thread.id));
      const visited = new Set<string>([thread.id]);
      let parent = thread.lineage.parentThreadId;
      while (parent !== null && !visited.has(parent)) {
        visited.add(parent);
        for (const number of refsByThread.get(parent) ?? []) refs.add(number);
        parent = byId.get(parent)?.lineage.parentThreadId ?? null;
      }
      if (refs.size === 0) continue;
      const state = workState(thread);
      const item = {
        threadId: thread.id,
        title: thread.title,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        pullRequests: threadPullRequestsOf(thread)
          .filter((pr) => pr.source !== "stack-dismissed")
          .map((pr) => pr.url),
        status: state,
      };
      for (const number of refs) {
        const linked = work.get(number) ?? [];
        linked.push(item);
        work.set(number, linked);
      }
    }
    return {
      ...list,
      issues: list.issues.map((issue) => {
        // PR references are a server-side lookup, not another copy of the issue timeline on the wire.
        const { pullRequestRefs: _pullRequestRefs, ...summary } = issue;
        return { ...summary, liveWork: work.get(issue.number) ?? [] };
      }),
    };
  });
  return IssueLinks.of({ link, enrich });
});

function workState(
  thread: OrchestrationV2ThreadShell,
): NonNullable<IssueSummary["liveWork"]>[number]["status"] {
  if (
    thread.pendingRuntimeRequest !== null &&
    runtimeRequestNeedsUser(thread.pendingRuntimeRequest.kind)
  )
    return "waiting_on_you";
  if (
    thread.activeRunId !== null ||
    ["queued", "preparing", "starting", "running", "waiting"].includes(thread.status) ||
    thread.activityRunStatus != null
  )
    return "working";
  return "idle";
}

export const layer = Layer.effect(IssueLinks, make);
