import { assert, it } from "@effect/vitest";
import {
  CommandId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  type OrchestrationV2DomainEvent,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Layer from "effect/Layer";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layer = EventSink.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      EventStore.layer,
      ProjectionStore.layer,
      CommandReceiptStore.layer,
      EffectOutbox.layer,
    ),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
);

it.effect("rejects a planned fork whose source was deleted before it committed", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const sourceId = ThreadId.make("fork-source");
    const targetId = ThreadId.make("fork-target");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const source: OrchestrationV2AppThread = {
      id: sourceId,
      projectId: ProjectId.make("project"),
      title: "Source",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: sourceId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      lastVisitedAt: null,
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("source-created"),
          type: "thread.created",
          threadId: sourceId,
          occurredAt: now,
          payload: source,
        },
      ],
    });
    const plannedFork = {
      commandId: CommandId.make("fork"),
      commandType: "thread.fork",
      threadId: targetId,
      acceptedAt: now,
      effects: [],
      events: [
        {
          id: EventId.make("fork-created"),
          type: "thread.created" as const,
          threadId: targetId,
          occurredAt: now,
          payload: {
            ...source,
            id: targetId,
            forkedFrom: { type: "run" as const, threadId: sourceId, runId: RunId.make("run") },
          },
        },
      ],
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("source-deleted"),
          type: "thread.deleted",
          threadId: sourceId,
          occurredAt: now,
          payload: { ...source, deletedAt: now },
        },
      ],
    });
    const rejected = yield* sink.commitCommand(plannedFork);
    assert.equal(rejected.receipt.status, "rejected");
    assert.isFalse(rejected.committed);
    const replayed = yield* sink.commitCommand(plannedFork);
    assert.deepEqual(replayed.receipt, rejected.receipt);
    assert.isFalse(replayed.committed);
    const missing = yield* projections.getThread(targetId).pipe(Effect.flip);
    assert.instanceOf(missing, ProjectionStore.ProjectionStoreThreadNotFoundError);
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["projection", "outbox"] as const)(
  "rolls back a managed claim, child, events, receipt and effects after a %s failure",
  (failure) =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const commandId = CommandId.make(`command:foundation-atomic-failure:${failure}`);
      const threadId = ThreadId.make(`thread:foundation-atomic-failure:${failure}`);
      const scopeId = CheckpointScopeId.make(`scope:foundation-atomic-failure:${failure}`);
      const checkpoint = (index: number) => ({
        id: CheckpointId.make(`checkpoint:foundation-atomic-failure:${failure}:${index}`),
        threadId,
        scopeId,
        runId: null,
        nodeId: NodeId.make(`node:foundation-atomic-failure:${failure}`),
        parentCheckpointId: null,
        ordinalWithinScope: 1,
        appRunOrdinal: null,
        ref: CheckpointRef.make(`checkpoint-ref:foundation-atomic-failure:${failure}:${index}`),
        status: "ready" as const,
        files: [],
        capturedAt: now,
      });
      const events: OrchestrationV2DomainEvent[] = (failure === "projection" ? [1, 2] : [1]).map(
        (index) =>
          ({
            id: EventId.make(`event:foundation-atomic-failure:${failure}:${index}`),
            type: "checkpoint.captured",
            threadId,
            occurredAt: now,
            payload: checkpoint(index),
          }) satisfies OrchestrationV2DomainEvent,
      );

      const issue = {
        host: "github.com",
        repository: "owner/repo",
        repositoryId: `atomic-repo:${failure}`,
        id: `atomic-issue:${failure}`,
        nodeId: "atomic-node",
        number: 1,
        title: "Atomic admission",
        url: "https://github.com/owner/repo/issues/1",
      };
      events.unshift(
        {
          id: EventId.make(`atomic-child-created:${failure}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            ...idleThreadProjection(liveThreadShell(threadId)).thread,
            linkedIssue: issue,
          },
        },
        {
          id: EventId.make(`atomic-request:${failure}`),
          type: "issue.work.requested",
          threadId,
          occurredAt: now,
          payload: {
            requestId: commandId,
            issue,
            parent: null,
            rootThreadId: threadId,
            issueThreadId: threadId,
            attemptKey: "first",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          },
        },
      );
      if (failure === "outbox")
        yield* sql`CREATE TRIGGER fail_admission_outbox BEFORE INSERT ON orchestration_v2_effect_outbox
            BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END`;

      const plan = {
        commandId,
        threadId,
        commandType: "checkpoint.atomicity-test",
        acceptedAt: now,
        events,
        effects: [
          {
            id: `effect:foundation-atomic-failure:${failure}`,
            commandId,
            threadId,
            request: {
              type: "provider-turn.start" as const,
              runId: RunId.make(`run:foundation-atomic-failure:${failure}`),
            },
          },
        ],
      };
      const exit = yield* Effect.exit(eventSink.commitCommand(plan)).pipe(
        Effect.ensuring(
          failure === "outbox"
            ? sql`DROP TRIGGER fail_admission_outbox`.pipe(Effect.orDie)
            : Effect.void,
        ),
      );
      assert.equal(exit._tag, "Failure");
      if (exit._tag !== "Failure") return yield* Effect.die("Expected commit failure");
      const error = Cause.squash(exit.cause);
      assert.nestedPropertyVal(
        error,
        "cause._tag",
        failure === "outbox" ? "EffectOutboxError" : "ProjectionStoreApplyEventError",
      );
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
      assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
      assert.deepEqual(
        yield* eventStore.readByCommandId({ commandId }).pipe(
          Stream.runCollect,
          Effect.map((events) => Array.from(events)),
        ),
        [],
      );
      const checkpointRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_v2_projection_checkpoints
        WHERE thread_id = ${threadId}
      `;
      assert.equal(checkpointRows[0]?.count, 0);
      assert.deepEqual(
        yield* sql`SELECT * FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`,
        [],
      );
      assert.deepEqual(
        yield* sql`SELECT * FROM orchestration_v2_projection_issue_work WHERE issue_id = ${issue.id}`,
        [],
      );
      assert.deepEqual(
        yield* sql`SELECT * FROM orchestration_v2_projection_issue_work_requests WHERE request_id = ${commandId}`,
        [],
      );
    }).pipe(Effect.provide(layer)),
);
