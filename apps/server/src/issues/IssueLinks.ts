import { repositoryPhaseSql } from "./RepositoryPhaseSql.ts";
import {
  IssueLinkError,
  RepositoryOrchestration,
  RepositoryIssueRef,
  type IssueRepositoryRef,
  type IssuePullRequestStatus,
  type RepositoryIssueSummary,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type { IssueWorkThread } from "./IssueWorkProjection.ts";
import { isExplicitlyPausedThread } from "@t3tools/shared/threadActivity";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  legacyThreadPullRequestKey,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "../sourceControl/threadPullRequests.ts";
import { issuePullRequests } from "@t3tools/source-control-definitions/issuePullRequests";
import { classifyIssueWorker } from "@t3tools/shared/issueWorkerStatus";
import { issueWorkThreadIds } from "./IssueWorkQuery.ts";

const key = (issue: RepositoryIssueRef) =>
  `${issue.host.toLowerCase()}/${issue.repository.toLowerCase()}#${issue.number}`;
const encodeMemoKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodePrRefs = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(RepositoryIssueRef)));
const decodeOrchestration = Schema.decodeEffect(Schema.fromJsonString(RepositoryOrchestration));
const storageError = (cause: unknown) => new IssueLinkError({ code: "storage", cause });

type WorkList = {
  readonly repository: IssueRepositoryRef;
  readonly issues: readonly (Pick<RepositoryIssueSummary, "number" | "pullRequestRefs"> & {
    readonly state?: RepositoryIssueSummary["state"];
    readonly pullRequests?: readonly IssuePullRequestStatus[] | undefined;
    readonly closingPullRequests?: readonly IssuePullRequestStatus[] | undefined;
  })[];
};

/** Live work per issue: claims, `thread.issues[]` links, owned pull requests and descendants. */
export class IssueLinks extends Context.Service<
  IssueLinks,
  {
    readonly enrich: <T extends WorkList>(
      list: T,
    ) => Effect.Effect<
      T & {
        readonly issues: readonly (T["issues"][number] &
          Pick<RepositoryIssueSummary, "liveWork" | "pullRequestCount" | "suspensionReason">)[];
      },
      IssueLinkError
    >;
  }
>()("t3/issues/IssueLinks") {}

type LinkRow = { issue_number: number; thread_id: string };

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const workByRepository = new Map<
    string,
    {
      revision: number;
      queries: Map<
        string,
        Effect.Effect<
          {
            readonly threads: ReadonlyArray<IssueWorkThread>;
            readonly parentById: ReadonlyMap<string, string | null>;
            readonly routingParents: ReadonlyArray<IssueWorkThread>;
          },
          IssueLinkError
        >
      >;
      threadLinks: Effect.Effect<ReadonlyArray<LinkRow>, IssueLinkError>;
    }
  >();
  const enrich: IssueLinks["Service"]["enrich"] = Effect.fn("IssueLinks.enrich")(function* <
    T extends WorkList,
  >(list: T) {
    const host = list.repository.host.toLowerCase();
    const repository = list.repository.repository.toLowerCase();
    const issueNumbers = list.issues.map((issue) => issue.number);
    const prRefs = list.issues.flatMap((issue) => issue.pullRequestRefs ?? []);
    const prRefsJson = yield* encodePrRefs(prRefs).pipe(Effect.mapError(storageError));
    const revision = yield* projections.issueWorkRevision.pipe(Effect.mapError(storageError));
    const repositoryKey = `${host}/${repository}`;
    let memo = workByRepository.get(repositoryKey);
    if (memo === undefined || memo.revision !== revision) {
      memo = {
        revision,
        queries: new Map(),
        // ponytail: scans every thread's links once per event revision, shared by every page;
        // a projected link table indexed by issue if this shows up in profiles.
        threadLinks: yield* Effect.cached(
          sql<LinkRow>`
            SELECT CAST(json_extract(link.value, '$.key') AS INTEGER) AS issue_number, thread.thread_id
            FROM orchestration_v2_projection_threads thread,
              json_each(CASE WHEN json_valid(thread.payload_json) THEN thread.payload_json ELSE '{}' END, '$.issues') link
            WHERE thread.deleted_at IS NULL
              AND json_extract(link.value, '$.tracker') = 'github'
              AND lower(json_extract(link.value, '$.host')) = ${host}
              AND lower(json_extract(link.value, '$.scope')) = ${repository}
          `.pipe(NodeSqliteClient.readOnly, Effect.mapError(storageError)),
        ),
      };
      workByRepository.set(repositoryKey, memo);
    }
    const rows = yield* memo.threadLinks;
    // The GitHub candidate set is outside the event projection, so paging and newly discovered
    // closing PRs invalidate their own reads.
    const queryKey = encodeMemoKey([issueNumbers, prRefsJson]);
    const queries = memo.queries;
    let read = queries.get(queryKey);
    if (read === undefined) {
      read = yield* Effect.cached(
        Effect.gen(function* () {
          const candidates =
            issueNumbers.length === 0
              ? []
              : yield* issueWorkThreadIds(
                  sql,
                  list.repository,
                  issueNumbers,
                  rows
                    .filter((row) => issueNumbers.includes(row.issue_number))
                    .map((row) => row.thread_id),
                  prRefsJson,
                  prRefs.length > 0,
                ).pipe(NodeSqliteClient.readOnly);
          const threads = yield* projections.getIssueWorkThreads(
            candidates.flatMap(({ thread_id, deleted_at }) =>
              deleted_at === null ? [ThreadId.make(thread_id)] : [],
            ),
          );
          const ids = new Set(threads.map((thread) => thread.id));
          const parentIds = new Set(
            threads.flatMap((thread) => {
              const parentId = thread.pendingRuntimeRequest?.routedTo;
              return parentId === undefined || ids.has(parentId) ? [] : [parentId];
            }),
          );
          const routingParents =
            parentIds.size === 0 ? [] : yield* projections.getIssueWorkThreads([...parentIds]);
          return {
            threads,
            parentById: new Map(
              candidates.map(({ thread_id, parent_thread_id }) => [thread_id, parent_thread_id]),
            ),
            routingParents,
          };
        }).pipe(
          Effect.mapError(storageError),
          Effect.tapError(() => Effect.sync(() => queries.delete(queryKey))),
        ),
      );
      // Keep only recent issue pages for this revision, rather than every search ever opened.
      if (memo.queries.size >= 32) memo.queries.delete(memo.queries.keys().next().value!);
      memo.queries.set(queryKey, read);
    }
    const { threads, parentById, routingParents } = yield* read;
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
    // Shells may expose observed PR arrays instead of the legacy owned link. Read the owned
    // link from the selected projection rows; observed PRs must never associate issue work.
    const ownedPrByThread = new Map(
      threads.flatMap((thread) =>
        thread.linkedPullRequest == null ? [] : [[thread.id, thread.linkedPullRequest] as const],
      ),
    );
    for (const thread of threads) {
      if (thread.linkedIssue !== undefined) {
        const number = issues.get(key(thread.linkedIssue));
        if (number !== undefined) add(thread.id, number);
      }
      const pr = ownedPrByThread.get(thread.id);
      if (pr !== undefined)
        for (const number of issuesByPr.get(key(legacyThreadPullRequestKey(pr))) ?? [])
          add(thread.id, number);
    }
    // Delegated and native child shells inherit associations from their ancestors. A visited set
    // bounds corrupt lineage; each selected shell is read once, never per issue.
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const linked = threads.flatMap((thread) => {
      const refs = new Set(refsByThread.get(thread.id));
      const visited = new Set<string>([thread.id]);
      let parent: string | null = thread.lineage.parentThreadId;
      while (parent !== null && !visited.has(parent)) {
        visited.add(parent);
        for (const number of refsByThread.get(parent) ?? []) refs.add(number);
        parent = parentById.get(parent) ?? null;
      }
      return refs.size === 0 ? [] : [{ thread, refs }];
    });
    // Children usually share an ancestor's worktree, and every check waits on Node's file thread
    // pool, which startup work saturates, so each distinct path is checked once, concurrently.
    const worktreePaths = new Set(
      linked.flatMap(({ thread }) => (thread.worktreePath === null ? [] : [thread.worktreePath])),
    );
    const existingWorktrees = new Set<string>();
    yield* Effect.forEach(
      worktreePaths,
      (path) =>
        fs.exists(path).pipe(
          Effect.orElseSucceed(() => false),
          Effect.map((exists) => {
            if (exists) existingWorktrees.add(path);
          }),
        ),
      { concurrency: 16, discard: true },
    );
    const suspensions = new Map<string, string>();
    const roots = [
      ...new Set(
        threads
          .filter((thread) => thread.linkedIssue !== undefined)
          .map((thread) => thread.lineage.rootThreadId),
      ),
    ];
    if (roots.length > 0) {
      const rows = yield* sql<{ config_json: string }>`
        SELECT json_extract(payload_json, '$.repositoryOrchestration') AS config_json
        FROM orchestration_v2_projection_threads
        WHERE thread_id IN ${sql.in(roots)}
          AND lower(json_extract(payload_json, '$.repositoryOrchestration.host')) = ${host}
          AND lower(json_extract(payload_json, '$.repositoryOrchestration.repository')) = ${repository}
          AND ${sql.unsafe(repositoryPhaseSql("payload_json"))} <> 'retired'
      `.pipe(NodeSqliteClient.readOnly, Effect.mapError(storageError));
      for (const row of rows) {
        const config = yield* decodeOrchestration(row.config_json).pipe(
          Effect.mapError(storageError),
        );
        for (const entry of config.suspendedIssues) suspensions.set(entry.id, entry.reason);
      }
    }
    const suspensionReasons = new Map(
      threads.flatMap((thread) => {
        const reason =
          thread.linkedIssue === undefined ? undefined : suspensions.get(thread.linkedIssue.id);
        return reason === undefined || thread.linkedIssue === undefined
          ? []
          : [[thread.linkedIssue.number, reason] as const];
      }),
    );
    const parentsById = new Map(routingParents.map((thread) => [thread.id, thread]));
    const work = new Map<number, NonNullable<RepositoryIssueSummary["liveWork"]>[number][]>();
    for (const { thread, refs } of linked) {
      const parentId = thread.pendingRuntimeRequest?.routedTo;
      const state = classifyIssueWorker(
        thread,
        parentId === undefined ? undefined : (byId.get(parentId) ?? parentsById.get(parentId)),
      );
      const item = {
        threadId: thread.id,
        title: thread.title,
        ...(thread.role === undefined ? {} : { role: thread.role }),
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        worktreeExists: thread.worktreePath !== null && existingWorktrees.has(thread.worktreePath),
        pullRequests: visibleThreadPullRequests(threadPullRequestsOf(thread)).map((pr) => pr.url),
        ...state,
        ...(state.status === "idle" && isExplicitlyPausedThread(thread)
          ? { paused: true as const }
          : {}),
      };
      for (const number of refs) {
        const linked = work.get(number) ?? [];
        const inherited = !refsByThread.get(thread.id)?.has(number);
        linked.push({
          ...item,
          inherited,
        });
        work.set(number, linked);
      }
    }
    return {
      ...list,
      issues: list.issues.map((issue) => {
        // PR references are a server-side lookup, not another copy of the issue timeline on the wire.
        const { pullRequestRefs, ...summary } = issue;
        const liveWork = (work.get(issue.number) ?? []).filter(
          (item) => issue.state === "closed" || byId.get(item.threadId)?.archivedAt === null,
        );
        const closingPullRequests =
          issue.closingPullRequests ??
          issue.pullRequests ??
          (pullRequestRefs ?? []).map((ref) => ({
            ...ref,
            url: `https://${ref.host}/${ref.repository}/pull/${ref.number}`,
            title: "",
            state: null,
            isDraft: false,
          }));
        const pullRequests = issuePullRequests(
          closingPullRequests,
          liveWork.flatMap((item) => {
            const thread = byId.get(item.threadId);
            return thread === undefined ? [] : threadPullRequestsOf(thread);
          }),
        );
        return {
          ...summary,
          suspensionReason: suspensionReasons.get(issue.number),
          closingPullRequests,
          pullRequests,
          pullRequestCount: pullRequests.length,
          liveWork,
        };
      }),
    };
  });
  return IssueLinks.of({ enrich });
});

export const layer = Layer.effect(IssueLinks, make);
