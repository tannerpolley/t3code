import {
  EventId,
  IssueReadError,
  IssueTrackerKind,
  MessageId,
  ProjectId,
  RunId,
  TurnItemId,
  type IssueListEntry,
  type RepositoryIssueSummary,
  type IssueMilestone,
  type OrchestrationV2Run,
  ThreadId,
  NodeId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TestClock from "effect/testing/TestClock";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { assert, it } from "@effect/vitest";
import { IssueLinkError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TrackerIssueService from "../issue/IssueService.ts";
import * as IssueService from "./IssueService.ts";
import * as IssueLinks from "./IssueLinks.ts";
import * as IssueRoadmap from "./IssueRoadmap.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const roadmapLayer = IssueRoadmap.layer.pipe(
  Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const input = { host: "github.com", repository: "owner/repo" };
const projectId = ProjectId.make("project");
const github = IssueTrackerKind.make("github");
const scope = { projectId, tracker: github, host: "github.com", scope: "owner/repo" };
const entry = (key: string, overrides: Partial<IssueListEntry> = {}): IssueListEntry => ({
  tracker: github,
  host: "github.com",
  scope: "owner/repo",
  key,
  displayKey: `#${key}`,
  title: `Issue ${key}`,
  url: `https://github.com/owner/repo/issues/${key}`,
  author: { login: "octocat", name: null, avatarUrl: "https://avatars.example/octocat" },
  state: { category: "open", name: "Open" },
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  closedAt: null,
  assignees: [],
  labels: [],
  commentCount: 0,
  projectId,
  projectTitle: "repo",
  ...overrides,
});
const milestone: IssueMilestone = {
  number: 1,
  title: "Release",
  state: "open",
  dueAt: null,
  url: "https://github.com/owner/repo/milestone/1",
  openCount: 3,
  closedCount: 1,
};
const row = (
  number: number,
  fields: Partial<RepositoryIssueSummary> = {},
): RepositoryIssueSummary => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/owner/repo/issues/${number}`,
  state: "open",
  stateReason: null,
  author: null,
  assignees: [],
  labels: [],
  milestone: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  closedAt: null,
  commentCount: 0,
  projects: [],
  ...fields,
});
const tracker = Layer.mock(TrackerIssueService.IssueService)({
  resolveUrl: () => Effect.succeed({ ...scope, key: "1", writable: true }),
});

function forkIssues(
  revision: { value: number },
  overlayFails = { value: false },
  repositoryIssuesPage?: IssueService.IssueService["Service"]["repositoryIssuesPage"],
) {
  return Layer.mock(IssueService.IssueService)({
    ...(repositoryIssuesPage === undefined ? {} : { repositoryIssuesPage }),
    revision: () => Effect.sync(() => revision.value),
    milestones: (request) =>
      Effect.succeed(
        request.page === 1 ? { items: [milestone], nextPage: 2 } : { items: [], nextPage: null },
      ),
    overlay: (request) =>
      Effect.sync(() =>
        overlayFails.value
          ? Option.none()
          : Option.some(
              new Map(
                request.numbers.map((number) => [
                  number,
                  {
                    milestone: { ...milestone, openCount: 0, closedCount: 0 },
                    blockedBy: [{ ...input, number: 2, state: "open" as const }],
                    parent: null,
                    relationshipsComplete: true,
                    subIssues: { total: 2, completed: 1 },
                    pullRequestRefs: [{ ...input, number: 42 }],
                  },
                ]),
              ),
            ),
      ),
  });
}

const failingLinks = Layer.mock(IssueLinks.IssueLinks)({
  enrich: () => Effect.fail(new IssueLinkError({ code: "storage", cause: "unavailable" })),
});

it.effect("joins REST issue pages with the fork overlay and caches incomplete rows briefly", () => {
  const calls: unknown[] = [];
  const revision = { value: 0 };
  const overlayFails = { value: false };
  const pending = [
    {
      items: [
        row(13, {
          labels: [
            { name: "bug", color: "d73a4a" },
            { name: "odd", color: null },
          ],
        }),
        row(14, { state: "closed", stateReason: "not_planned", closedAt: "2026-10-02T00:00:00Z" }),
      ],
      nextPage: 2,
    },
    ...[15, 16, 17, 18, 18, 18].map((number) => ({ items: [row(number)], nextPage: null })),
  ];
  const layer = roadmapLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        tracker,
        forkIssues(revision, overlayFails, (request) =>
          Effect.sync(() => {
            calls.push(request);
            return pending.shift()!;
          }),
        ),
        failingLinks,
      ),
    ),
  );
  return Effect.gen(function* () {
    const roadmap = yield* IssueRoadmap.IssueRoadmap;
    const first = yield* roadmap.list({ ...input, state: "all" });
    assert.deepEqual(
      first.issues.map((issue) => [issue.number, issue.state, issue.stateReason]),
      [
        [13, "open", null],
        [14, "closed", "not_planned"],
      ],
    );
    const [open] = first.issues;
    assert.deepEqual(open?.milestone, milestone, "the listed milestone carries its counts");
    assert.deepEqual(open?.labels, [
      { name: "bug", color: "d73a4a" },
      { name: "odd", color: null },
    ]);
    assert.deepEqual(open?.blockedBy, [{ ...input, number: 2, state: "open" }]);
    assert.deepEqual(open?.subIssues, { total: 2, completed: 1 });
    assert.deepEqual(open?.liveWork, [], "work storage failures keep the rows");
    assert.notProperty(open!, "pullRequestRefs");
    assert.deepEqual(first.milestones, [milestone]);
    assert.isFalse(first.issuesComplete);
    assert.isFalse(first.milestonesComplete);

    const second = yield* roadmap.list({ ...input, state: "all", cursor: first.nextCursor! });
    assert.deepEqual(
      second.issues.map((issue) => issue.number),
      [15],
    );
    assert.isTrue(second.issuesComplete && second.milestonesComplete);
    assert.isNull(second.nextCursor);
    assert.deepEqual(calls[1], { ...input, state: "all", page: 2, cursor: first.nextCursor });

    // Signals and mounts re-read local work only; GitHub is read again after a change.
    for (let index = 0; index < 5; index++) yield* roadmap.list({ ...input, state: "all" });
    assert.equal(calls.length, 2);
    revision.value++;
    assert.equal((yield* roadmap.list({ ...input, state: "all" })).issues[0]?.number, 16);
    yield* TestClock.adjust("5 minutes");
    assert.equal((yield* roadmap.list({ ...input, state: "all" })).issues[0]?.number, 17);
    yield* roadmap.list({ ...input, state: "all", refresh: true });
    assert.equal(calls.length, 5);

    // Incomplete rows are cached briefly and then the overlay is retried.
    overlayFails.value = true;
    revision.value++;
    for (let index = 0; index < 2; index++)
      assert.isFalse(
        (yield* roadmap.list({ ...input, state: "all" })).issues[0]?.relationshipsComplete,
      );
    assert.equal(calls.length, 6);
    yield* TestClock.adjust("1 minute");
    yield* roadmap.list({ ...input, state: "all" });
    assert.equal(calls.length, 7);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "refuses a repository without a project and reuses a failed listing until its retry deadline",
  () => {
    let writable = false;
    let reads = 0;
    const layer = roadmapLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(TrackerIssueService.IssueService)({
            resolveUrl: () => Effect.succeed({ ...scope, key: "1", writable }),
          }),
          forkIssues({ value: 0 }, undefined, () =>
            Effect.suspend(() =>
              ++reads === 1
                ? new IssueReadError({
                    operation: "list",
                    code: "rate-limited",
                    message: "GitHub API rate limit exceeded.",
                    retryAt: 120_000,
                  })
                : Effect.succeed({ items: [], nextPage: null }),
            ),
          ),
          failingLinks,
        ),
      ),
    );
    return Effect.gen(function* () {
      const roadmap = yield* IssueRoadmap.IssueRoadmap;
      assert.equal((yield* roadmap.list(input).pipe(Effect.flip)).code, "scope-unavailable");
      writable = true;
      yield* TestClock.adjust("1 minute");
      const limited = yield* roadmap.list(input).pipe(Effect.flip);
      assert.deepEqual([limited.code, limited.retryAt], ["rate-limited", 120_000]);
      assert.equal((yield* roadmap.list(input).pipe(Effect.flip)).code, "rate-limited");
      assert.equal(reads, 1);
      yield* TestClock.adjust("1 minute");
      assert.deepEqual((yield* roadmap.list(input)).issues, []);
      assert.equal(reads, 2);
      assert.equal(
        (yield* roadmap.list({ ...input, cursor: "not-a-cursor" }).pipe(Effect.flip)).code,
        "invalid-cursor",
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("gives an issue's detail the overlay and live work its row has", () => {
  let enrichedRefs: unknown;
  let detailReads = 0;
  const revision = { value: 0 };
  const layer = roadmapLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(TrackerIssueService.IssueService)({
          resolveUrl: () => Effect.succeed({ ...scope, key: "13", writable: true }),
          detail: () =>
            Effect.sync(() => {
              detailReads++;
              return {
                ...entry("13"),
                writable: true,
                capabilities: {} as never,
                viewerPermissions: {} as never,
                states: [],
                viewer: "octocat",
                body: "",
                comments: [],
                commentsCursor: null,
                events: [],
                linkedPullRequests: [
                  {
                    repository: "owner/repo",
                    number: 42,
                    title: "Closes",
                    state: "open" as const,
                    isDraft: false,
                    url: "https://github.com/owner/repo/pull/42",
                    closesIssue: true,
                  },
                ],
              };
            }),
        }),
        forkIssues(revision),
        Layer.mock(IssueLinks.IssueLinks)({
          enrich: (value) => {
            enrichedRefs = value.issues[0]?.pullRequestRefs;
            return Effect.succeed({
              ...value,
              issues: value.issues.map((issue) => ({ ...issue, liveWork: [] })),
            });
          },
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const roadmap = yield* IssueRoadmap.IssueRoadmap;
    const result = yield* roadmap.detail({ ...input, number: 13 });
    assert.deepEqual(enrichedRefs, [{ ...input, number: 42 }]);
    assert.deepEqual(result.issue.liveWork, []);
    assert.deepEqual(result.issue.subIssues, { total: 2, completed: 1 });
    assert.equal(result.linkedPullRequests[0]?.closesIssue, true);
    yield* roadmap.detail({ ...input, number: 13 });
    assert.equal(detailReads, 1);
    revision.value++;
    yield* roadmap.detail({ ...input, number: 13 });
    assert.equal(detailReads, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("reports live work in issue status batches when it has no pull requests", () => {
  const work = { threadId: ThreadId.make("worker"), inherited: false, status: "working" as const };
  const layer = roadmapLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        tracker,
        Layer.mock(IssueService.IssueService)({
          statusBatch: () =>
            Effect.succeed([
              {
                ...input,
                number: 13,
                nodeId: "I_13",
                state: "open",
                stateReason: null,
                blockedBy: [],
                pullRequests: [],
              },
            ]),
        }),
        Layer.mock(IssueLinks.IssueLinks)({
          enrich: (list) =>
            Effect.succeed({
              ...list,
              issues: list.issues.map((issue) => ({ ...issue, liveWork: [work] })),
            }),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const roadmap = yield* IssueRoadmap.IssueRoadmap;
    const [status] = yield* roadmap.statusBatch({ issues: [{ host: input.host, nodeId: "I_13" }] });
    assert.deepEqual(status?.liveWork, [work]);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "live work follows held queue release and every run admission and activity transition",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const events = yield* EventStore.EventStoreV2;
        const links = yield* IssueLinks.IssueLinks;
        const sql = yield* SqlClient.SqlClient;
        const now = DateTime.makeUnsafe("2026-10-20T00:00:00Z");
        const thread = {
          ...idleThreadProjection(liveThreadShell(ThreadId.make("held"))).thread,
          linkedIssue: {
            ...input,
            number: 13,
            repositoryId: "repo",
            id: "13",
            nodeId: "I_13",
            title: "Issue",
            url: "https://github.com/owner/repo/issues/13",
          },
        };
        const apply = Effect.fn("test.applyQueueEvent")(function* (
          event: OrchestrationV2DomainEvent,
        ) {
          yield* events.append({ events: [event] });
          yield* projections.apply(event);
        });
        yield* apply({
          id: EventId.make("thread"),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: now,
          payload: thread,
        });
        const run: OrchestrationV2Run = {
          id: RunId.make("held-run"),
          threadId: thread.id,
          ordinal: 1,
          providerInstanceId: thread.providerInstanceId,
          modelSelection: thread.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message"),
          rootNodeId: NodeId.make("root"),
          activeAttemptId: null,
          status: "queued",
          queueHeld: true,
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        const created = {
          id: EventId.make("held"),
          type: "run.created" as const,
          threadId: thread.id,
          occurredAt: now,
          payload: run,
        };
        yield* apply(created);
        const workInput = { repository: input, issues: [{ number: 13, state: "open" as const }] };
        const state = Effect.gen(function* () {
          const enriched = yield* links.enrich(workInput);
          const [row] = yield* sql<{
            slots: number;
          }>`SELECT count(*) AS slots FROM orchestration_v2_projection_runs WHERE status IN ('preparing', 'starting', 'running', 'waiting')`;
          return { status: enriched.issues[0]!.liveWork![0]!.status, slots: row!.slots };
        });
        assert.deepEqual(yield* state, { status: "idle", slots: 0 });
        let revision = 1;
        for (const [status, queueHeld, liveWork, slots] of [
          ["queued", false, "queued", 0],
          ["queued", true, "idle", 0],
          ["queued", false, "queued", 0],
          ["preparing", false, "working", 1],
          ["starting", false, "working", 1],
          ["running", false, "working", 1],
          ["waiting", false, "working", 1],
          ["completed", false, "done", 0],
          ["running", false, "working", 1],
          ["failed", false, "failed", 0],
          ["running", false, "working", 1],
          ["interrupted", false, "idle", 0],
          ["running", false, "working", 1],
          ["cancelled", false, "idle", 0],
          ["running", false, "working", 1],
          ["rolled_back", false, "idle", 0],
        ] as const) {
          revision++;
          const event = {
            ...created,
            id: EventId.make(`transition-${revision}`),
            type: "run.updated" as const,
            payload: { ...run, status, queueHeld },
          };
          yield* apply(event);
          assert.deepEqual(yield* state, { status: liveWork, slots });
        }
        const waiting = {
          ...created,
          id: EventId.make("waiting-again"),
          type: "run.updated" as const,
          payload: { ...run, status: "waiting" as const, queueHeld: false },
        };
        yield* apply(waiting);
        const item = {
          id: TurnItemId.make("background"),
          threadId: thread.id,
          runId: run.id,
          nodeId: run.rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          type: "dynamic_tool" as const,
          toolName: "background",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        };
        for (const [status, persistent, liveWork] of [
          ["running", false, "idle"],
          ["running", true, "working"],
          ["running", false, "idle"],
          ["completed", false, "working"],
        ] as const) {
          const event = {
            id: EventId.make(`background-${++revision}`),
            type: "turn-item.updated" as const,
            threadId: thread.id,
            occurredAt: now,
            payload: { ...item, status, input: { persistent } },
          };
          yield* apply(event);
          assert.deepEqual(yield* state, { status: liveWork, slots: 1 });
        }
      }),
    ).pipe(
      Effect.provide(
        IssueLinks.layer.pipe(
          Layer.provideMerge(ProjectionStore.layer),
          Layer.provideMerge(EventStore.layer),
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
