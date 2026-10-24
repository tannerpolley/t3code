import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_REPOSITORY_WORK_SETTINGS,
  ProjectId,
  ThreadId,
  RuntimeRequestId,
  type IssueListResult,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Stream from "effect/Stream";
import * as IssueLinks from "./IssueLinks.ts";
import * as IssueRoadmap from "./IssueRoadmap.ts";
import * as IssueService from "./IssueService.ts";
import { issueWorkThreadIds } from "./IssueWorkQuery.ts";

const ref = { host: "github.com", repository: "owner/repo", number: 13 };
const threadId = ThreadId.make("ordinary-builder");
function harness(initial: OrchestrationV2ThreadShell[]) {
  let shells = initial;
  let revision = 0;
  const lookups: string[] = [];
  const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    issueWorkRevision: Effect.sync(() => revision),
    getIssueWorkThreads: (ids) =>
      Effect.sync(() => {
        lookups.push(...ids);
        return ids.flatMap((id) => {
          const shell = shells.find((shell) => shell.id === id);
          return shell === undefined ? [] : [shell];
        });
      }),
    getThreadShell: (id) =>
      Effect.sync(() => {
        lookups.push(id);
        return shells.find((thread) => thread.id === id) ?? null;
      }),
    readShellSnapshot: (options) =>
      Effect.sync(() => {
        assert.isDefined(options?.threadIds, "Roadmap must not read the full shell snapshot");
        const selected = shells.filter((shell) => options!.threadIds!.includes(shell.id));
        lookups.push(...options!.threadIds!);
        return {
          schemaVersion: 2 as const,
          snapshotSequence: 0,
          threads: selected.filter((shell) => shell.archivedAt === null),
          archivedThreads: selected.filter((shell) => shell.archivedAt !== null),
        };
      }).pipe(Effect.map(Effect.succeed)),
  });
  const seed = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const shell of initial)
        yield* sql`
      INSERT INTO orchestration_v2_projection_threads(
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, archived_at, deleted_at, payload_json
      ) VALUES (${shell.id}, ${shell.projectId}, ${shell.title}, 'codex', 'full-access', 'default',
        '2026-10-13', '2026-10-13', ${shell.archivedAt === null ? null : "2026-10-13"},
        ${shell.deletedAt === null ? null : "2026-10-13"}, ${JSON.stringify(shell)})`;
    }),
  );
  const layer = IssueLinks.layer.pipe(
    Layer.provide(projections),
    Layer.provide(seed),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  );
  return {
    layer,
    setShells: (next: OrchestrationV2ThreadShell[]) => {
      shells = next;
      revision++;
    },
    lookups,
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
      assert.isTrue(
        (yield* links.enrich(list())).issues[0]?.liveWork?.find(
          (work) => work.threadId === threadId,
        )?.canUnlink,
      );
      assert.equal((yield* links.link(ref, threadId, true)).changed, true);
      assert.equal((yield* links.link(ref, threadId, true)).changed, false);
      assert.equal(yield* Stream.runHead(links.refreshes).pipe(Effect.map(Option.getOrThrow)), 4);
      assert.deepEqual(
        (yield* links.enrich(list())).issues[0]?.liveWork?.map((work) => work.threadId),
        ["another"],
      );
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
  "sidebar status includes ordinarily linked running work beside an idle managed thread",
  () => {
    const managed = {
      ...liveThreadShell(ThreadId.make("managed"), { activeRunId: null }),
      status: "idle" as const,
      linkedIssue: {
        ...ref,
        repositoryId: "repo",
        id: "13",
        nodeId: "I_13",
        title: "Roadmap",
        url: "https://github.com/owner/repo/issues/13",
      },
    };
    const ordinary = liveThreadShell(threadId);
    const h = harness([managed, ordinary]);
    const layer = IssueRoadmap.layer.pipe(
      Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty })),
      Layer.provideMerge(h.layer),
      Layer.provide(
        Layer.mock(IssueService.IssueService)({
          refreshes: Stream.empty,
          list: () => Effect.succeed(list()),
          statusBatch: () =>
            Effect.succeed([
              {
                ...ref,
                nodeId: "I_13",
                state: "open" as const,
                stateReason: null,
                blockedBy: [],
                pullRequests: [],
              },
            ]),
        }),
      ),
    );
    return Effect.gen(function* () {
      yield* (yield* IssueLinks.IssueLinks).link(ref, ordinary.id);
      const roadmap = yield* IssueRoadmap.IssueRoadmap;
      const pane = yield* roadmap.list({ ...ref, roadmap: true });
      const badge = yield* roadmap.statusBatch({ issues: [{ host: ref.host, nodeId: "I_13" }] });
      const compact = pane.issues[0]!.liveWork!.map(({ threadId, inherited, status }) => ({
        threadId,
        inherited,
        status,
      }));
      assert.deepEqual(badge[0]?.liveWork, compact);
      assert.deepEqual(compact, [
        { threadId: managed.id, inherited: false, status: "idle" },
        { threadId: ordinary.id, inherited: false, status: "working" },
      ]);
      assert.deepEqual(badge[0]?.closingPullRequests, []);
      assert.notProperty(badge[0]!, "repository");
      assert.notProperty(badge[0]!.liveWork![0]!, "title");
    }).pipe(Effect.provide(layer));
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
  "loads only explicitly linked, managed, closing-PR and descendant work, and refreshes live state",
  () => {
    const root = {
      ...liveThreadShell(threadId, { activeRunId: null }),
      status: "completed" as const,
    };
    const child = {
      ...liveThreadShell(ThreadId.make("delegated")),
      role: "investigator" as const,
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
    const grandchild = {
      ...child,
      id: ThreadId.make("grandchild"),
      lineage: { ...child.lineage, parentThreadId: child.id },
    };
    const unrelated = {
      ...pr,
      pullRequests: [
        {
          host: "github.com",
          repository: "owner/repo",
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          source: "manual" as const,
          linkedAt: "2026-10-13T00:00:00Z",
          snapshot: null,
          stack: null,
        },
      ],
      id: ThreadId.make("unrelated-pr"),
      linkedPullRequest: { ...pr.linkedPullRequest, number: 99 },
    };
    const foreignHost = {
      ...pr,
      id: ThreadId.make("foreign-host"),
      linkedPullRequest: {
        ...pr.linkedPullRequest,
        url: "https://github.enterprise.test/owner/repo/pull/42",
      },
    };
    const otherRepo = {
      ...managed,
      id: ThreadId.make("other-repo"),
      linkedIssue: { ...managed.linkedIssue, repository: "other/repo" },
    };
    const modern = {
      ...pr,
      id: ThreadId.make("modern-pr"),
      linkedPullRequest: {
        ...pr.linkedPullRequest,
        repository: "other/repo",
        url: "https://github.com/other/repo/pull/42",
      },
      pullRequests: [
        {
          host: "github.com",
          repository: "other/repo",
          number: 42,
          url: "https://github.com/other/repo/pull/42",
          source: "manual" as const,
          linkedAt: "2026-10-13T00:00:00Z",
          snapshot: null,
          stack: null,
        },
      ],
    };
    const dismissed = {
      ...modern,
      id: ThreadId.make("dismissed"),
      linkedPullRequest: null,
      pullRequests: modern.pullRequests.map((link) => ({
        ...link,
        source: "stack-dismissed" as const,
      })),
    };
    const unlinked = {
      ...pr,
      id: ThreadId.make("unlinked"),
      linkedPullRequest: null,
      pullRequests: [],
    };
    const h = harness([
      root,
      child,
      grandchild,
      managed,
      pr,
      inactive,
      unrelated,
      foreignHost,
      otherRepo,
      modern,
      dismissed,
      unlinked,
    ]);
    return Effect.gen(function* () {
      const links = yield* IssueLinks.IssueLinks;
      yield* links.link(ref, threadId);
      yield* links.link(ref, managed.id); // Two sources for one thread must not duplicate its indicator.
      const input = list();
      const withPr = {
        ...input,
        issues: [
          {
            ...input.issues[0]!,
            pullRequestRefs: [
              { ...ref, number: 42 },
              { ...ref, repository: "other/repo", number: 42 },
            ],
          },
        ],
      };
      h.lookups.length = 0;
      const first = yield* links.enrich(withPr);
      assert.deepEqual(h.lookups, [
        child.id,
        foreignHost.id,
        grandchild.id,
        managed.id,
        modern.id,
        threadId,
        pr.id,
      ]);
      assert.notProperty(first.issues[0]!, "pullRequestRefs");
      assert.equal(first.issues[0]!.pullRequestCount, 2);
      assert.deepEqual(
        first.issues[0]!.pullRequests?.map((pr) => [pr.host, pr.repository, pr.number]),
        [
          ["github.com", "owner/repo", 42],
          ["github.com", "other/repo", 42],
        ],
      );
      const work = first.issues[0]!.liveWork!;
      assert.deepEqual(
        work.filter((item) => item.canUnlink).map((item) => item.threadId),
        [managed.id, threadId],
      );
      assert.deepEqual(
        work.map((item) => [item.threadId, item.status]),
        [
          [child.id, "idle"],
          [grandchild.id, "idle"],
          [managed.id, "working"],
          [modern.id, "working"],
          [threadId, "idle"],
          [pr.id, "working"],
        ],
      );
      assert.deepEqual(work.find((item) => item.threadId === child.id)?.worktreePath, "/work/13");
      assert.equal(work.find((item) => item.threadId === child.id)?.role, "investigator");
      assert.notProperty(
        work.find((item) => item.threadId === managed.id)!,
        "role",
      );
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
        (yield* links.enrich(withPr)).issues[0]!.liveWork?.find(
          (item) => item.threadId === child.id,
        )?.status,
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

it.effect("bounds cyclic descendant lineage without loading unrelated threads", () => {
  const childId = ThreadId.make("cycle-child");
  const root = {
    ...liveThreadShell(threadId),
    lineage: {
      rootThreadId: threadId,
      parentThreadId: childId,
      relationshipToParent: "subagent" as const,
    },
  };
  const child = {
    ...liveThreadShell(childId),
    lineage: {
      rootThreadId: threadId,
      parentThreadId: threadId,
      relationshipToParent: "subagent" as const,
    },
  };
  const h = harness([root, child, liveThreadShell(ThreadId.make("unrelated"))]);
  return Effect.gen(function* () {
    const links = yield* IssueLinks.IssueLinks;
    yield* links.link(ref, threadId);
    h.lookups.length = 0;
    const result = yield* links.enrich(list());
    assert.deepEqual(h.lookups, [childId, threadId]);
    assert.deepEqual(
      result.issues[0]?.liveWork?.map((item) => item.threadId),
      [childId, threadId],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "uses indexed issue, PR candidate and descendant reads with no full thread-table scans",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ANALYZE orchestration_v2_projection_threads`;
      for (const includeArchived of [true, false]) {
        for (const hasPrRefs of [true, false]) {
          const linkedIds = hasPrRefs ? [threadId] : [];
          const query = issueWorkThreadIds(
            sql,
            ref,
            [13],
            linkedIds,
            '[{"host":"github.com","repository":"owner/repo","number":42}]',
            hasPrRefs,
            includeArchived,
          );
          const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN ${query}`;
          const details = plan.map((row) => row.detail).join("\n");
          if (linkedIds.length > 0)
            assert.include(
              details,
              "SEARCH explicit USING INDEX sqlite_autoindex_orchestration_v2_projection_threads_1",
            );
          else assert.notInclude(details, "explicit");
          assert.include(
            details,
            "SEARCH issue_thread USING INDEX issue_roadmap_linked_issue_idx (<expr>=? AND <expr>=? AND <expr>=?)",
          );
          assert.include(details, "SEARCH child USING INDEX issue_roadmap_parent_idx (<expr>=?)");
          if (hasPrRefs)
            assert.include(
              details,
              "SEARCH pr_thread USING INDEX issue_roadmap_linked_pr_idx (<expr>=? AND <expr>=?)",
            );
          else assert.notInclude(details, "pr_thread");
          assert.include(
            details,
            "SEARCH selected USING INDEX sqlite_autoindex_orchestration_v2_projection_threads_1",
          );
          assert.notInclude(query.compile()[0], "$.pullRequests");
          for (const detail of plan.map((row) => row.detail)) {
            if (
              !detail.startsWith("SCAN ") ||
              detail === "SCAN linked" ||
              detail.includes("VIRTUAL TABLE INDEX")
            )
              continue;
            assert.fail(`Unexpected scan: ${detail}\n${details}`);
          }
        }
      }
    }).pipe(
      Effect.provide(
        harness(
          Array.from({ length: 50 }, (_, index) => {
            const id = index === 0 ? threadId : ThreadId.make(`plan-${index}`);
            const base = liveThreadShell(id);
            return {
              ...base,
              lineage: { ...base.lineage, parentThreadId: index > 0 ? threadId : null },
              linkedIssue: {
                ...ref,
                number: index + 1,
                repositoryId: "repo",
                id: `${index}`,
                nodeId: `I_${index}`,
                title: "Plan",
                url: `https://github.com/owner/repo/issues/${index + 1}`,
              },
              linkedPullRequest: {
                projectId: base.projectId,
                repository: "owner/repo",
                number: index + 1,
                url: `https://github.com/owner/repo/pull/${index + 1}`,
              },
            };
          }),
        ).layer,
      ),
    ),
);

it.effect("does not count stale active IDs or parked background work as a running agent", () => {
  const base = {
    ...liveThreadShell(threadId),
    linkedIssue: {
      ...ref,
      repositoryId: "repo",
      id: "13",
      nodeId: "I_13",
      title: "Fix",
      url: "https://github.com/owner/repo/issues/13",
    },
  };
  const h = harness([base]);
  return Effect.gen(function* () {
    const links = yield* IssueLinks.IssueLinks;
    for (const [thread, expected] of [
      [{ ...base, status: "running" as const }, "working"],
      [{ ...base, status: "completed" as const, activityRunStatus: "running" as const }, "working"],
      [{ ...base, status: "completed" as const }, "idle"],
      [
        {
          ...base,
          status: "running" as const,
          pendingBackgroundTasks: [{ kind: "monitor" as const, taskId: "monitor" }],
        },
        "idle",
      ],
      [
        {
          ...base,
          status: "running" as const,
          pendingBackgroundTasks: [{ kind: "command" as const, taskId: "server" }],
        },
        "working",
      ],
    ] as const) {
      h.setShells([thread]);
      assert.equal((yield* links.enrich(list())).issues[0]?.liveWork?.[0]?.status, expected);
    }
  }).pipe(Effect.provide(h.layer));
});

it.effect("returns closing and linked-thread PRs with state, deduplicating the same PR", () => {
  const pr = {
    host: ref.host,
    repository: ref.repository,
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
    source: "manual" as const,
    linkedAt: "2026-10-15T00:00:00Z",
    stack: null,
    snapshot: {
      state: "open" as const,
      title: "Fix",
      isDraft: true,
      headBranch: "fix",
      baseBranch: "main",
      updatedAt: null,
      syncedAt: "2026-10-15T00:00:00Z",
    },
  };
  const thread = {
    ...liveThreadShell(threadId),
    pullRequests: [
      pr,
      {
        ...pr,
        number: 43,
        url: "https://github.com/owner/repo/pull/43",
        snapshot: { ...pr.snapshot, state: "merged" as const },
      },
      { ...pr, number: 44, source: "stack-dismissed" as const },
    ],
  };
  const h = harness([thread]);
  return Effect.gen(function* () {
    const links = yield* IssueLinks.IssueLinks;
    yield* links.link(ref, threadId);
    const input = list();
    const result = yield* links.enrich({
      ...input,
      issues: [{ ...input.issues[0]!, pullRequestRefs: [{ ...ref, number: 42 }] }],
    });
    assert.equal(result.issues[0]?.pullRequestCount, 2);
    assert.deepEqual(
      result.issues[0]?.closingPullRequests?.map((pr) => pr.number),
      [42],
    );
    assert.deepEqual(
      result.issues[0]?.pullRequests?.map((pr) => [pr.number, pr.state, pr.isDraft]),
      [
        [42, "open", true],
        [43, "merged", true],
      ],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "retains archived worker associations on closed issues without showing them on open issues",
  () => {
    const archived = {
      ...liveThreadShell(threadId),
      archivedAt: DateTime.makeUnsafe("2026-10-19T12:00:00Z"),
      linkedIssue: {
        ...ref,
        repositoryId: "repo",
        id: "13",
        nodeId: "I_13",
        title: "Roadmap",
        url: "https://github.com/owner/repo/issues/13",
      },
    };
    const h = harness([archived]);
    return Effect.gen(function* () {
      const links = yield* IssueLinks.IssueLinks;
      assert.deepEqual((yield* links.enrich(list())).issues[0]?.liveWork, []);
      const source = list();
      const closed = yield* links.enrich({
        ...source,
        issues: source.issues.map((issue) => ({ ...issue, state: "closed" as const })),
      });
      assert.equal(closed.issues[0]?.liveWork?.[0]?.threadId, threadId);
      assert.equal(closed.issues[0]?.liveWork?.[0]?.status, "idle");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("reports whether a closed issue's preserved worktree path still exists", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const worktreePath = `${directory}/worker`;
    yield* fs.makeDirectory(worktreePath);
    const base = liveThreadShell(threadId, { activeRunId: null });
    const h = harness([
      {
        ...base,
        worktreePath,
        linkedIssue: {
          ...ref,
          repositoryId: "repo",
          id: "13",
          nodeId: "I_13",
          title: "Roadmap",
          url: "https://github.com/owner/repo/issues/13",
        },
      },
    ]);
    yield* Effect.gen(function* () {
      const links = yield* IssueLinks.IssueLinks;
      const source = list();
      Object.assign(source.issues[0]!, { state: "closed" });
      assert.isTrue((yield* links.enrich(source)).issues[0]?.liveWork?.[0]?.worktreeExists);
      yield* fs.remove(worktreePath, { recursive: true });
      const work = (yield* links.enrich(source)).issues[0]?.liveWork?.[0];
      assert.equal(work?.worktreePath, worktreePath);
      assert.isFalse(work?.worktreeExists);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "allows writes during the lightweight projection and truncation after its reader ends",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-issue-enrich-" });
      const filename = `${directory}/state.sqlite`;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const links = yield* IssueLinks.IssueLinks;
        yield* sql`CREATE TABLE contention_probe (value INTEGER)`;
        for (let index = 0; index < 100; index++) {
          const thread = idleThreadProjection(
            liveThreadShell(ThreadId.make(`batch-${index}`)),
          ).thread;
          yield* sql`
        INSERT INTO orchestration_v2_projection_threads(
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (${thread.id}, ${thread.projectId}, ${thread.title}, 'codex', 'full-access', 'default',
          '2026-10-13', '2026-10-13', NULL, NULL, ${JSON.stringify(thread)})`;
          yield* sql`INSERT INTO issue_thread_links(host, repository, issue_number, thread_id)
        VALUES (${ref.host}, ${ref.repository}, ${ref.number}, ${thread.id})`;
        }
        const other = yield* Effect.acquireRelease(
          Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
          (db) => Effect.sync(() => db.close()),
        );
        other.exec("PRAGMA busy_timeout = 0");
        let writerResult: unknown;
        let checkpointResult: unknown;
        let batches = 0;

        let statements = 0;
        const connections: unknown[] = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            if (span.name === "sqlite") statements++;
            const end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              if (span.name === "sqlite") connections.push(span.attributes.get("db.connection"));
              if (
                span.name === "sqlite" &&
                String(span.attributes.get("db.query.text")).includes("AS thread_json")
              ) {
                batches++;
                if (writerResult === undefined) {
                  try {
                    other.exec("INSERT INTO contention_probe VALUES (1)");
                    writerResult = true;
                  } catch (error) {
                    writerResult = error;
                  }
                }
              }
              if (span.name === "IssueLinks.readWorkProjection" && checkpointResult === undefined) {
                try {
                  checkpointResult = other.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
                } catch (error) {
                  checkpointResult = error;
                }
              }
            };
            return span;
          },
        });
        const enriched = yield* links
          .enrich(list())
          .pipe(
            Effect.provideService(Statement.SpanPropagationEnabled, true),
            Effect.withTracer(tracer),
          );
        assert.sameMembers(
          enriched.issues[0]?.liveWork?.map((work) => work.threadId) ?? [],
          Array.from({ length: 100 }, (_, index) => `batch-${index}`),
        );
        assert.strictEqual(writerResult, true);
        assert.deepEqual(checkpointResult, { busy: 0, log: 0, checkpointed: 0 });
        assert.equal(batches, 1, "one lightweight projection covers all candidates");
        assert.isNotEmpty(connections);
        assert.deepEqual(
          connections,
          Array.from({ length: connections.length }, () => "reader"),
        );
        assert.isAtMost(statements, 5, "work reads must not grow with the number of threads");
      }).pipe(
        Effect.provide(
          IssueLinks.layer.pipe(
            Layer.provide(ProjectionStore.layer),
            Layer.provideMerge(SqlitePersistence.layerFromPath(filename)),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("memoizes unchanged work and invalidates it on the next projected thread change", () => {
  const thread = liveThreadShell(threadId);
  const h = harness([thread]);
  return Effect.gen(function* () {
    const links = yield* IssueLinks.IssueLinks;
    yield* links.link(ref, threadId);
    h.lookups.length = 0;
    const first = yield* links.enrich(list());
    const reads = h.lookups.length;
    assert.isAbove(reads, 0);
    assert.deepEqual(yield* links.enrich(list()), first);
    assert.equal(h.lookups.length, reads, "unchanged projections must not be read again");
    h.setShells([{ ...thread, title: "Changed", status: "completed", activeRunId: null }]);
    const next = yield* links.enrich(list());
    assert.equal(next.issues[0]?.liveWork?.[0]?.title, "Changed");
    assert.equal(next.issues[0]?.liveWork?.[0]?.status, "idle");
  }).pipe(Effect.provide(h.layer));
});

it.effect("roadmap work exposes and clears its repository suspension reason", () => {
  const root = liveThreadShell(ThreadId.make("suspension-root"));
  const reason = "Issue relationships are unreadable. Restore access before resuming.";
  const orchestrator = {
    ...root,
    repositoryOrchestration: {
      host: ref.host,
      repository: ref.repository,
      repositoryId: "repo",
      projectId: root.projectId,
      launchCommandId: CommandId.make("suspension-root:create"),
      revision: 1,
      paused: false,
      ...DEFAULT_REPOSITORY_WORK_SETTINGS,
      milestones: [],
      suspendedIssues: [{ id: "13", reason }],
    },
  };
  const managed = {
    ...liveThreadShell(threadId),
    lineage: {
      rootThreadId: root.id,
      parentThreadId: root.id,
      relationshipToParent: "subagent" as const,
    },
    linkedIssue: {
      ...ref,
      repositoryId: "repo",
      id: "13",
      nodeId: "I_13",
      title: "Roadmap",
      url: "https://github.com/owner/repo/issues/13",
    },
  };
  const h = harness([orchestrator, managed]);
  return Effect.gen(function* () {
    const links = yield* IssueLinks.IssueLinks;
    assert.equal((yield* links.enrich(list())).issues[0]!.suspensionReason, reason);
    const sql = yield* SqlClient.SqlClient;
    const resumed = {
      ...orchestrator,
      repositoryOrchestration: {
        ...orchestrator.repositoryOrchestration,
        revision: 2,
        suspendedIssues: [],
      },
    };
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${JSON.stringify(resumed)} WHERE thread_id = ${root.id}`;
    assert.isUndefined((yield* links.enrich(list())).issues[0]!.suspensionReason);
  }).pipe(Effect.provide(h.layer));
});
