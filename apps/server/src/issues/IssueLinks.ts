import {
  IssueLinkError,
  IssueRef,
  type IssueLinkInput,
  type IssueLinkResult,
  type IssueListResult,
  type IssueSummary,
  type ThreadId,
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
    const [snapshot, rows] = yield* Effect.all([
      projections.getShellSnapshot({ location: "active" }),
      sql<{
        issue_number: number;
        thread_id: string;
      }>`SELECT issue_number, thread_id FROM issue_thread_links
        WHERE host = ${list.repository.host.toLowerCase()} AND repository = ${list.repository.repository.toLowerCase()}`,
    ]).pipe(Effect.mapError(storageError));
    const threads = snapshot.threads.filter(
      (thread) => thread.deletedAt === null && thread.archivedAt === null,
    );
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
    // bounds corrupt lineage; each shell is read once in the existing snapshot, never per issue.
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
      issues: list.issues.map((issue) => ({ ...issue, liveWork: work.get(issue.number) ?? [] })),
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
