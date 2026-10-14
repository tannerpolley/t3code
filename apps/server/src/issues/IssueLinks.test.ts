import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  RuntimeRequestId,
  type IssueListResult,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as IssueLinks from "./IssueLinks.ts";

const ref = { host: "github.com", repository: "owner/repo", number: 13 };
const threadId = ThreadId.make("ordinary-builder");
function harness(initial: OrchestrationV2ThreadShell[]) {
  let shells = initial;
  let snapshots = 0;
  const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThreadShell: (id) => Effect.sync(() => shells.find((thread) => thread.id === id) ?? null),
    getShellSnapshot: () =>
      Effect.sync(() => {
        snapshots++;
        return { schemaVersion: 2, snapshotSequence: 0, threads: shells, archivedThreads: [] };
      }),
  });
  const layer = IssueLinks.layer.pipe(
    Layer.provide(projections),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return {
    layer,
    setShells: (next: OrchestrationV2ThreadShell[]) => {
      shells = next;
    },
    snapshotCount: () => snapshots,
  };
}
function list(): IssueListResult {
  return {
    repository: ref,
    viewer: null,
    fetchedAt: "2026-10-13T00:00:00Z",
    milestones: [],
    nextCursor: null,
    issuesComplete: true,
    milestonesComplete: true,
    issues: [
      {
        number: 13,
        title: "Roadmap",
        url: "https://github.com/owner/repo/issues/13",
        state: "open",
        stateReason: null,
        author: null,
        assignees: [],
        labels: [],
        milestone: null,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
        commentCount: 0,
        blockedBy: [],
        parent: null,
        relationshipsComplete: true,
      },
    ],
  };
}

it.effect(
  "ordinary threads link multiple issues durably and idempotently, without a repository owner; unlink is scoped",
  () => {
    const h = harness([liveThreadShell(threadId), liveThreadShell(ThreadId.make("another"))]);
    return Effect.gen(function* () {
      const links = yield* IssueLinks.IssueLinks;
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* links.link({ url: "https://github.com/Owner/Repo/issues/13" }, threadId)).changed,
        true,
      );
      assert.equal((yield* links.link(ref, threadId)).changed, false);
      assert.equal((yield* links.link({ ...ref, number: 14 }, threadId)).changed, true);
      assert.equal(
        (yield* links.link({ ...ref, threadId: ThreadId.make("another") }, threadId)).changed,
        true,
      );
      assert.equal((yield* sql`SELECT * FROM issue_thread_links`).length, 3);
      assert.equal((yield* links.link(ref, threadId, true)).changed, true);
      assert.equal((yield* links.link(ref, threadId, true)).changed, false);
      assert.deepEqual(
        yield* sql`SELECT issue_number, thread_id FROM issue_thread_links ORDER BY issue_number`,
        [
          { issue_number: 13, thread_id: "another" },
          { issue_number: 14, thread_id: threadId },
        ],
      );
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "rejects malformed or conflicting targets and unavailable threads before saving a link",
  () => {
    const h = harness([liveThreadShell(threadId)]);
    return Effect.gen(function* () {
      const links = yield* IssueLinks.IssueLinks;
      for (const input of [
        {},
        { repository: "owner/repo", number: 0 },
        { url: "https://github.com/owner/repo/pull/13" },
        { url: "https://github.com/owner/repo/issues/13", number: 14 },
        { url: "http://github.com/owner/repo/issues/13" },
      ]) {
        const result = yield* links.link(input, threadId).pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.equal(result.failure.code, "invalid-request");
      }
      const missing = yield* links.link(ref, ThreadId.make("missing")).pipe(Effect.result);
      assert.isTrue(Result.isFailure(missing));
      if (Result.isFailure(missing)) assert.equal(missing.failure.code, "thread-not-found");
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(yield* sql`SELECT * FROM issue_thread_links`, []);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "combines explicit, managed, PR and child work in one snapshot and clears working state on the next refresh",
  () => {
    const root = {
      ...liveThreadShell(threadId, { activeRunId: null }),
      status: "completed" as const,
    };
    const child = {
      ...liveThreadShell(ThreadId.make("delegated")),
      branch: "feature/13",
      worktreePath: "/work/13",
      lineage: {
        rootThreadId: threadId,
        parentThreadId: threadId,
        relationshipToParent: "subagent" as const,
      },
    };
    const managed = {
      ...liveThreadShell(ThreadId.make("managed")),
      linkedIssue: {
        ...ref,
        repositoryId: "repo-id",
        id: "13",
        nodeId: "I_13",
        title: "Roadmap",
        url: "https://github.com/owner/repo/issues/13",
      },
    };
    const pr = {
      ...liveThreadShell(ThreadId.make("pr-builder")),
      linkedPullRequest: {
        projectId: ProjectId.make("project:mcp-test"),
        repository: "owner/repo",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      },
    };
    const inactive = {
      ...liveThreadShell(ThreadId.make("archived")),
      linkedIssue: managed.linkedIssue,
      archivedAt: DateTime.makeUnsafe("2026-10-13T00:00:00Z"),
    };
    const h = harness([root, child, managed, pr, inactive]);
    return Effect.gen(function* () {
      const links = yield* IssueLinks.IssueLinks;
      yield* links.link(ref, threadId);
      yield* links.link(ref, managed.id); // Two sources for one thread must not duplicate its indicator.
      const input = list();
      const withPr = {
        ...input,
        issues: [{ ...input.issues[0]!, pullRequestRefs: [{ ...ref, number: 42 }] }],
      };
      const first = yield* links.enrich(withPr);
      assert.equal(h.snapshotCount(), 1);
      assert.notProperty(first.issues[0]!, "pullRequestRefs");
      const work = first.issues[0]!.liveWork!;
      assert.deepEqual(
        work.map((item) => [item.threadId, item.status]),
        [
          [threadId, "idle"],
          [child.id, "working"],
          [managed.id, "working"],
          [pr.id, "working"],
        ],
      );
      assert.deepEqual(work.find((item) => item.threadId === child.id)?.worktreePath, "/work/13");
      assert.deepEqual(work.find((item) => item.threadId === pr.id)?.pullRequests, [
        "https://github.com/owner/repo/pull/42",
      ]);
      h.setShells([
        root,
        {
          ...child,
          status: "waiting",
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("question"),
            kind: "user_input",
            createdAt: DateTime.makeUnsafe("2026-10-13T00:00:00Z"),
          },
        },
      ]);
      assert.equal(
        (yield* links.enrich(withPr)).issues[0]!.liveWork?.[1]?.status,
        "waiting_on_you",
      );
      h.setShells([root, { ...child, status: "completed", activeRunId: null }]);
      assert.deepEqual(
        (yield* links.enrich(withPr)).issues[0]!.liveWork?.map((item) => item.status),
        ["idle", "idle"],
      );
      yield* links.link(ref, threadId, true);
      assert.deepEqual((yield* links.enrich(withPr)).issues[0]!.liveWork, []);
    }).pipe(Effect.provide(h.layer));
  },
);
