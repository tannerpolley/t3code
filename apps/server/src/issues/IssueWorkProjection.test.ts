import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ProviderDriverKind,
  TurnItemId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Tracer from "effect/Tracer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as IssueLinks from "./IssueLinks.ts";

it.effect(
  "preserves full-shell liveWork and PR output, memoizes it, and observes the next thread event",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const now = DateTime.makeUnsafe("2026-10-20T00:00:00Z");
      const reference = { host: "github.com", repository: "owner/repo", number: 13 };
      const pr = {
        host: "github.com",
        repository: "owner/repo",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        source: "manual" as const,
        linkedAt: "2026-10-20T00:00:00Z",
        stack: null,
        snapshot: {
          state: "open" as const,
          title: "Fix",
          isDraft: false,
          headBranch: "fix",
          baseBranch: "main",
          updatedAt: null,
          syncedAt: "2026-10-20T00:00:00Z",
        },
      };
      const scenarios = [
        "idle",
        "running",
        "queued",
        "held",
        "completed",
        "waiting",
        "monitor",
        "question",
        "auth",
        "archived",
        "native",
        "observed",
        "limited",
        "inherited",
        "explicit",
        "legacy",
      ] as const;
      const apply = Effect.fn("test.applyIssueWorkEvent")(function* (
        event: OrchestrationV2DomainEvent,
      ) {
        yield* events.append({ events: [event] });
        yield* projections.apply(event);
      });
      for (const name of scenarios) {
        const id = ThreadId.make(name);
        const thread = {
          ...idleThreadProjection(liveThreadShell(id)).thread,
          role: "investigator" as const,
          ...(name === "inherited" || name === "explicit"
            ? {}
            : {
                linkedIssue: {
                  ...reference,
                  repositoryId: "repo",
                  id: "13",
                  nodeId: "I_13",
                  title: "Issue",
                  url: "https://github.com/owner/repo/issues/13",
                },
              }),
          ...(name === "archived" ? { archivedAt: now } : {}),
          ...(name === "inherited"
            ? {
                lineage: {
                  rootThreadId: ThreadId.make("idle"),
                  parentThreadId: ThreadId.make("idle"),
                  relationshipToParent: "subagent" as const,
                },
              }
            : {}),
          ...(name === "legacy"
            ? {}
            : {
                pullRequests:
                  name === "inherited" || name === "explicit"
                    ? []
                    : name === "monitor"
                      ? [
                          {
                            ...pr,
                            watch: {
                              startedAt: "2026-10-20T00:00:00Z",
                              headSha: null,
                              failedChecks: [],
                              passed: false,
                              passedChecks: [],
                              remarksThrough: "2026-10-20T00:00:00Z",
                              remarkIds: [],
                              conflicting: false,
                              wakes: 0,
                            },
                          },
                        ]
                      : [pr],
              }),
          linkedPullRequest:
            name === "observed" || name === "inherited" || name === "explicit"
              ? null
              : {
                  projectId: liveThreadShell(id).projectId,
                  repository: pr.repository,
                  number: pr.number,
                  url: pr.url,
                },
        };
        yield* apply({
          id: EventId.make(`thread-${name}`),
          type: "thread.created",
          threadId: id,
          occurredAt: now,
          payload: thread,
        });
        const nodeId = NodeId.make(`node-${name}`);
        const runId = RunId.make(`run-${name}`);
        const run: OrchestrationV2Run = {
          id: runId,
          threadId: id,
          ordinal: 1,
          providerInstanceId: thread.providerInstanceId,
          modelSelection: thread.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`message-${name}`),
          rootNodeId: nodeId,
          activeAttemptId: null,
          status:
            name === "held" || name === "queued"
              ? "queued"
              : name === "running"
                ? "running"
                : name === "waiting" || name === "question" || name === "auth" || name === "monitor"
                  ? "waiting"
                  : "completed",
          ...(name === "held" ? { queueHeld: true } : {}),
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        if (name !== "idle" && name !== "native")
          yield* apply({
            id: EventId.make(`event-run-${name}`),
            type: "run.created",
            threadId: id,
            runId,
            nodeId,
            occurredAt: now,
            payload: name === "limited" ? { ...run, status: "failed", completedAt: now } : run,
          });
        if (name === "limited") {
          yield* apply({
            id: EventId.make("limit-error"),
            type: "turn-item.updated",
            threadId: id,
            runId,
            nodeId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("limit-error"),
              threadId: id,
              runId,
              nodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "failed",
              title: "Usage limit",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "error",
              failure: {
                class: "usage_limit",
                message: "Plan limit reached.",
                code: "usageLimitExceeded",
                retryable: null,
              },
            },
          });
          yield* apply({
            id: EventId.make("queued-after-limit"),
            type: "run.created",
            threadId: id,
            runId: RunId.make("next-limited"),
            nodeId,
            occurredAt: now,
            payload: {
              ...run,
              id: RunId.make("next-limited"),
              ordinal: 2,
              status: "queued",
              startedAt: null,
            },
          });
        }
        if (name === "question" || name === "auth")
          yield* apply({
            id: EventId.make(`request-${name}`),
            type: "runtime-request.updated",
            threadId: id,
            runId,
            nodeId,
            occurredAt: now,
            payload: {
              id: RuntimeRequestId.make(`request-${name}`),
              nodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: name === "auth" ? "auth_refresh" : "user_input",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          });
        if (name === "native")
          yield* apply({
            id: EventId.make("native"),
            type: "subagent.updated",
            threadId: ThreadId.make("idle"),
            nodeId,
            occurredAt: now,
            payload: {
              id: nodeId,
              threadId: ThreadId.make("idle"),
              runId: null,
              parentNodeId: NodeId.make("native-parent"),
              origin: "provider_native",
              createdBy: "agent",
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: thread.providerInstanceId,
              providerThreadId: null,
              childThreadId: id,
              nativeTaskRef: null,
              prompt: "Inspect",
              title: null,
              model: null,
              status: "running",
              result: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            },
          });
      }
      const links = yield* IssueLinks.IssueLinks;
      yield* links.link(reference, ThreadId.make("explicit"));
      const input = {
        repository: reference,
        issues: [
          { number: 13, state: "closed" as const, pullRequestRefs: [{ ...reference, number: 42 }] },
        ],
      };
      const fullShells = Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        ...projections,
        getIssueWorkThreads: (ids) =>
          projections.readShellSnapshot({ threadIds: ids }).pipe(
            Effect.flatten,
            Effect.map((snapshot) =>
              [...snapshot.threads, ...snapshot.archivedThreads].sort((a, b) =>
                a.id.localeCompare(b.id),
              ),
            ),
          ),
      });
      const expected = yield* Effect.flatMap(IssueLinks.IssueLinks, (links) =>
        links.enrich(input),
      ).pipe(Effect.provide(Layer.fresh(IssueLinks.layer).pipe(Layer.provide(fullShells))));
      let reads = 0;
      const tracer = Tracer.make({
        span(options) {
          if (options.name === "IssueLinks.readWorkProjection") reads++;
          return new Tracer.NativeSpan(options);
        },
      });
      const first = yield* links.enrich(input).pipe(Effect.withTracer(tracer));
      assert.deepEqual(first, expected);
      const work = first.issues[0]!.liveWork!;
      assert.equal(work.find((item) => item.threadId === "inherited")?.inherited, true);
      assert.equal(work.find((item) => item.threadId === "explicit")?.canUnlink, true);
      assert.equal(work.find((item) => item.threadId === "archived")?.status, "idle");
      assert.deepEqual(work.find((item) => item.threadId === "legacy")?.pullRequests, [pr.url]);
      assert.equal(first.issues[0]!.pullRequestCount, 1);
      assert.equal(
        first.issues[0]?.liveWork?.find((work) => work.threadId === "question")?.status,
        "waiting_on_you",
      );
      assert.equal(
        first.issues[0]?.liveWork?.find((work) => work.threadId === "native")?.status,
        "working",
      );
      assert.deepEqual(yield* links.enrich(input).pipe(Effect.withTracer(tracer)), first);
      assert.equal(reads, 1);
      const thread = yield* projections.getThread(ThreadId.make("running"));
      yield* apply({
        id: EventId.make("renamed"),
        type: "thread.metadata-updated",
        threadId: thread.id,
        occurredAt: now,
        payload: { ...thread, title: "Renamed" },
      });
      const changed = yield* links.enrich(input).pipe(Effect.withTracer(tracer));
      assert.equal(
        changed.issues[0]?.liveWork?.find((work) => work.threadId === "running")?.title,
        "Renamed",
      );
      assert.equal(reads, 2);
    }).pipe(
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
