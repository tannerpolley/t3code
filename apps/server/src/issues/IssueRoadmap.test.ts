import {
  EventId,
  MessageId,
  RunId,
  TurnItemId,
  type OrchestrationV2Run,
  ThreadId,
  NodeId,
  ProviderDriverKind,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import { IssueLinkError, IssueReadError, type IssueListResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IssueService from "./IssueService.ts";
import * as IssueLinks from "./IssueLinks.ts";
import * as IssueRoadmap from "./IssueRoadmap.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const roadmapLayer = IssueRoadmap.layer.pipe(
  Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const input = { host: "github.com", repository: "owner/repo" };
const list: IssueListResult = {
  repository: input,
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
      pullRequestRefs: [{ ...input, number: 42 }],
    },
  ],
};

it.effect(
  "skips local work for Milestones and keeps Roadmap issues when optional link storage fails",
  () => {
    let reads = 0;
    const layer = roadmapLayer.pipe(
      Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty })),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(IssueService.IssueService)({
            refreshes: Stream.empty,
            list: () => Effect.succeed(list),
          }),
          Layer.mock(IssueLinks.IssueLinks)({
            enrich: () =>
              Effect.gen(function* () {
                reads++;
                return yield* new IssueLinkError({ code: "storage", cause: "unavailable" });
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const roadmap = yield* IssueRoadmap.IssueRoadmap;
      assert.strictEqual(yield* roadmap.list(input), list);
      assert.strictEqual(yield* roadmap.list({ ...input, roadmap: false }), list);
      assert.equal(reads, 0);
      const result = yield* roadmap.list({ ...input, roadmap: true });
      assert.equal(reads, 1);
      assert.equal(result.issues[0]?.title, "Roadmap");
      assert.deepEqual(result.issues[0]?.blockedBy, []);
      assert.deepEqual(result.issues[0]?.liveWork, []);
      assert.notProperty(result.issues[0]!, "pullRequestRefs");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("preserves an underlying GitHub read failure", () => {
  const error = new IssueReadError({
    code: "upstream",
    operation: "list",
    message: "GitHub unavailable",
  });
  const layer = roadmapLayer.pipe(
    Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty })),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(IssueService.IssueService)({
          refreshes: Stream.empty,
          list: () => Effect.fail(error),
        }),
        Layer.mock(IssueLinks.IssueLinks)({
          enrich: () => Effect.die("should not enrich a failed list"),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const roadmap = yield* IssueRoadmap.IssueRoadmap;
    assert.strictEqual(yield* roadmap.list({ ...input, roadmap: true }).pipe(Effect.flip), error);
  }).pipe(Effect.provide(layer));
});

it.effect("gives an issue's detail the live work its row has, matched by closing PRs", () => {
  const { pullRequestRefs: _refs, ...summary } = list.issues[0]!;
  const detail = {
    repository: input,
    viewer: null,
    fetchedAt: "2026-10-13T00:00:00Z",
    issue: summary,
    body: "",
    comments: [],
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
      {
        repository: "owner/repo",
        number: 43,
        title: "Mentions",
        state: "open" as const,
        isDraft: false,
        url: "https://github.com/owner/repo/pull/43",
        closesIssue: false,
      },
    ],
  };
  let enrichedRefs: IssueListResult["issues"][number]["pullRequestRefs"];
  const layer = roadmapLayer.pipe(
    Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty })),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(IssueService.IssueService)({
          refreshes: Stream.empty,
          detail: () => Effect.succeed(detail),
        }),
        Layer.mock(IssueLinks.IssueLinks)({
          enrich: (value) => {
            enrichedRefs = value.issues[0]?.pullRequestRefs;
            return Effect.succeed({
              ...value,
              issues: value.issues.map(({ pullRequestRefs: _ignored, ...issue }) => ({
                ...issue,
                liveWork: [],
              })),
            });
          },
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const result = yield* (yield* IssueRoadmap.IssueRoadmap).detail({ ...input, number: 13 });
    assert.deepEqual(enrichedRefs, [{ ...input, number: 42 }]);
    assert.deepEqual(result.issue.liveWork, []);
    assert.equal(result.linkedPullRequests.length, 2);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "coalesces metadata bursts and ignores subagent progress without a work-state change",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const roadmap = yield* IssueRoadmap.IssueRoadmap.pipe(
          Effect.provide(
            roadmapLayer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(IssueService.IssueService)({ refreshes: Stream.empty }),
                  Layer.mock(IssueLinks.IssueLinks)({ refreshes: Stream.make(0) }),
                  Layer.mock(Orchestrator.OrchestratorV2)({
                    streamDomainEvents: Stream.fromQueue(changes),
                  }),
                ),
              ),
            ),
          ),
        );
        const observed: number[] = [];
        const result = yield* roadmap.linkRefreshes.pipe(
          Stream.tap((revision) =>
            Effect.sync(() => {
              observed.push(revision);
            }),
          ),
          Stream.take(4),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* TestClock.adjust(0);
        const thread = idleThreadProjection(liveThreadShell(ThreadId.make("root"))).thread;
        for (const id of ["ownership", "queue"]) {
          yield* Queue.offer(changes, {
            id: EventId.make(id),
            type: "thread.metadata-updated",
            threadId: thread.id,
            occurredAt: thread.updatedAt,
            payload: thread,
          });
        }
        yield* TestClock.adjust("250 millis");
        assert.deepEqual(observed, [0, 1]);
        const nodeId = NodeId.make("worker");
        const subagent = {
          id: nodeId,
          threadId: thread.id,
          runId: null,
          parentNodeId: nodeId,
          origin: "provider_native" as const,
          createdBy: "agent" as const,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: thread.providerInstanceId,
          providerThreadId: null,
          childThreadId: ThreadId.make("worker"),
          nativeTaskRef: null,
          prompt: "Inspect",
          title: null,
          model: null,
          status: "running" as const,
          result: null,
          startedAt: thread.updatedAt,
          completedAt: null,
          updatedAt: thread.updatedAt,
        };
        const event = {
          id: EventId.make("running"),
          type: "subagent.updated" as const,
          threadId: thread.id,
          nodeId,
          occurredAt: thread.updatedAt,
          payload: subagent,
        };
        yield* Queue.offer(changes, event);
        yield* TestClock.adjust("250 millis");
        assert.deepEqual(observed, [0, 1, 2]);
        yield* Queue.offer(changes, {
          ...event,
          id: EventId.make("progress"),
          payload: { ...subagent, progress: "Still inspecting" },
        });
        yield* TestClock.adjust("250 millis");
        assert.deepEqual(observed, [0, 1, 2]);
        yield* Queue.offer(changes, {
          ...event,
          id: EventId.make("completed"),
          payload: { ...subagent, status: "completed" },
        });
        yield* TestClock.adjust("250 millis");
        assert.deepEqual(yield* Fiber.join(result), [0, 1, 2, 3]);
      }),
    ),
);

it.effect("refreshes held queue release and every run admission and activity transition", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const links = yield* IssueLinks.IssueLinks;
      const sql = yield* SqlClient.SqlClient;
      const changes = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
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
      const roadmap = yield* IssueRoadmap.IssueRoadmap.pipe(
        Effect.provide(
          roadmapLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(IssueService.IssueService)({ refreshes: Stream.empty }),
                Layer.succeed(IssueLinks.IssueLinks, links),
                Layer.mock(Orchestrator.OrchestratorV2)({
                  streamDomainEvents: Stream.fromQueue(changes),
                }),
              ),
            ),
          ),
        ),
      );
      const observed: number[] = [];
      yield* roadmap.linkRefreshes.pipe(
        Stream.runForEach((revision) =>
          Effect.sync(() => {
            observed.push(revision);
          }),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust(0);
      const workInput = { repository: input, issues: [{ number: 13, state: "open" as const }] };
      const state = Effect.gen(function* () {
        const enriched = yield* links.enrich(workInput);
        const [row] = yield* sql<{
          slots: number;
        }>`SELECT count(*) AS slots FROM orchestration_v2_projection_runs WHERE status IN ('preparing', 'starting', 'running', 'waiting')`;
        return { status: enriched.issues[0]!.liveWork![0]!.status, slots: row!.slots };
      });
      assert.deepEqual(yield* state, { status: "idle", slots: 0 });
      yield* Queue.offer(changes, created);
      yield* TestClock.adjust("250 millis");
      assert.deepEqual(observed, [0, 1]);
      let revision = 1;
      for (const [status, queueHeld, liveWork, slots] of [
        ["queued", false, "working", 0],
        ["queued", true, "idle", 0],
        ["queued", false, "working", 0],
        ["preparing", false, "working", 1],
        ["starting", false, "working", 1],
        ["running", false, "working", 1],
        ["waiting", false, "working", 1],
        ["completed", false, "idle", 0],
        ["running", false, "working", 1],
        ["failed", false, "idle", 0],
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
        yield* Queue.offer(changes, event);
        yield* TestClock.adjust("250 millis");
        assert.equal(observed.at(-1), revision, `${status}, held=${queueHeld} must refresh`);
        yield* Queue.offer(changes, {
          ...event,
          id: EventId.make(`progress-${revision}`),
          payload: { ...event.payload, startedAt: now },
        });
        yield* TestClock.adjust("250 millis");
        assert.equal(observed.length, revision + 1, "unchanged work state must not refresh");
      }
      const waiting = {
        ...created,
        id: EventId.make("waiting-again"),
        type: "run.updated" as const,
        payload: { ...run, status: "waiting" as const, queueHeld: false },
      };
      yield* apply(waiting);
      yield* Queue.offer(changes, waiting);
      yield* TestClock.adjust("250 millis");
      assert.equal(observed.at(-1), ++revision);
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
        yield* Queue.offer(changes, event);
        yield* TestClock.adjust("250 millis");
        assert.equal(observed.at(-1), revision);
        yield* Queue.offer(changes, {
          ...event,
          id: EventId.make(`item-progress-${revision}`),
          payload: { ...event.payload, output: "More output" },
        });
        yield* TestClock.adjust("250 millis");
        assert.equal(observed.length, revision + 1, "tool output must not refresh unchanged work");
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

it.effect(
  "pushes completed GitHub background reads through the existing Issues refresh stream",
  () =>
    Effect.gen(function* () {
      const revisions = yield* SubscriptionRef.make(0);
      const roadmap = yield* IssueRoadmap.IssueRoadmap.pipe(
        Effect.provide(
          roadmapLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(IssueService.IssueService)({
                  refreshes: SubscriptionRef.changes(revisions),
                }),
                Layer.mock(IssueLinks.IssueLinks)({ refreshes: Stream.make(0) }),
                Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
              ),
            ),
          ),
        ),
      );
      const observed: number[] = [];
      yield* roadmap.linkRefreshes.pipe(
        Stream.runForEach((revision) =>
          Effect.sync(() => {
            observed.push(revision);
          }),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust(0);
      assert.deepEqual(observed, [0]);
      yield* SubscriptionRef.update(revisions, (revision) => revision + 1);
      yield* TestClock.adjust("250 millis");
      assert.deepEqual(observed, [0, 1]);
    }),
);
