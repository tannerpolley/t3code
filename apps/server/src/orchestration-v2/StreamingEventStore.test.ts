import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./EventSink.ts";
import { EventStoreV2, layer as eventStoreLayer } from "./EventStore.ts";
import { ProjectionMaintenanceV2, layer as maintenanceLayer } from "./ProjectionMaintenance.ts";
import { ProjectionStoreV2, layer as projectionLayer } from "./ProjectionStore.ts";

const stores = Layer.mergeAll(eventStoreLayer, projectionLayer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const services = Layer.mergeAll(eventSinkLayer, maintenanceLayer).pipe(Layer.provideMerge(stores));

const fixture = (suffix: string, now: DateTime.Utc) => {
  const threadId = ThreadId.make(`thread:streaming:${suffix}`);
  const thread = {
    id: threadId,
    createdBy: "user" as const,
    creationSource: "web" as const,
    projectId: ProjectId.make(`project:${suffix}`),
    title: suffix,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const created: OrchestrationV2DomainEvent = {
    id: EventId.make(`event:${suffix}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  };
  const item = (
    index: number,
    text: string,
    status: "running" | "completed" | "cancelled" = "running",
    itemId = "a",
  ): OrchestrationV2DomainEvent => ({
    id: EventId.make(`event:${suffix}:${itemId}:${index}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item:${suffix}:${itemId}`),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 999,
      status,
      title: null,
      startedAt: now,
      completedAt: status === "running" ? null : now,
      updatedAt: now,
      type: "assistant_message",
      messageId: MessageId.make(`message:${suffix}:${itemId}`),
      text,
      streaming: status === "running",
    },
  });
  return { threadId, created, item };
};

for (const status of ["completed", "cancelled"] as const) {
  it.effect(`durably coalesces streaming snapshots through ${status}, with unchanged replay`, () =>
    Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      const events = yield* EventStoreV2;
      const projections = yield* ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const { threadId, created, item } = fixture(status, yield* DateTime.now);
      yield* sink.write({ events: [created] });
      let beforeBytes = 0;
      let firstBytes = 0;
      let previousSequence = 0;
      for (let index = 0; index < 200; index++) {
        const text = "x".repeat(50_000) + index;
        const update = item(index, text);
        // Estimate the old full-payload history using exactly the normalized
        // payload encoding that the real store wrote (including timestamps).
        const committed = yield* sink.write({ events: [update] });
        const sequence = committed[0]!.sequence;
        assert.isAbove(sequence, previousSequence);
        const bytes = yield* sql<{ bytes: number }>`
          SELECT length(CAST(payload_json AS BLOB)) AS bytes
          FROM orchestration_events WHERE sequence = ${sequence}
        `;
        beforeBytes += bytes[0]!.bytes;
        if (index === 0) firstBytes = bytes[0]!.bytes;
        const catchUp = yield* events
          .read({ threadId, afterSequence: previousSequence })
          .pipe(Stream.runCollect);
        assert.equal(catchUp.at(-1)?.sequence, sequence);
        const projected = yield* projections.getThreadProjection(threadId);
        assert.equal(
          projected.turnItems[0]?.type === "assistant_message" ? projected.turnItems[0].text : null,
          text,
        );
        previousSequence = sequence;
        if (index === 1) yield* sink.write({ events: [item(0, "second item", "completed", "b")] });
      }
      const finalText = "x".repeat(50_000) + "final";
      yield* sink.write({ events: [item(200, finalText, status)] });
      const retained = yield* sql<{ count: number; bytes: number }>`
        SELECT COUNT(*) AS count, SUM(length(CAST(payload_json AS BLOB))) AS bytes
        FROM orchestration_events
        WHERE event_type = 'turn-item.updated' AND stream_id = ${threadId}
          AND json_extract(payload_json, '$.id') = ${`item:${status}:a`}
      `;
      assert.equal(retained[0]!.count, 2);
      beforeBytes += retained[0]!.bytes - firstBytes;
      assert.isBelow(retained[0]!.bytes, beforeBytes / 50);
      const beforeReplay = yield* projections.getThreadProjection(threadId);
      assert.deepEqual(
        beforeReplay.turnItems.map((entry) => entry.ordinal),
        [1, 2],
      );
      assert.equal(beforeReplay.turnItems[0]!.status, status);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* projections.getThreadProjection(threadId), beforeReplay);
    }).pipe(Effect.provide(services)),
  );
}

it.effect(
  "keeps the last committed content after process loss and rolls back failed replacements",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* ProjectionMaintenanceV2;
      const projections = yield* ProjectionStoreV2;
      const { threadId, created, item } = fixture("restart", yield* DateTime.now);
      yield* sink.write({ events: [created, item(0, "first"), item(1, "second")] });
      const attempted = yield* sql
        .withTransaction(
          sink
            .write({ events: [item(2, "rolled back")] })
            .pipe(Effect.andThen(Effect.fail("simulated process failure"))),
        )
        .pipe(Effect.result);
      assert.isTrue(attempted._tag === "Failure");
      assert.isTrue((yield* maintenance.rebuild).valid);
      const replayed = yield* projections.getThreadProjection(threadId);
      assert.equal(
        replayed.turnItems[0]?.type === "assistant_message" ? replayed.turnItems[0].text : null,
        "second",
      );
      yield* sink.write({ events: [item(3, "committed after rollback")] });
      assert.isTrue((yield* maintenance.rebuild).valid);
      const afterRollback = yield* projections.getThreadProjection(threadId);
      assert.equal(
        afterRollback.turnItems[0]?.type === "assistant_message"
          ? afterRollback.turnItems[0].text
          : null,
        "committed after rollback",
      );

      // A new store instance has no coalescing cache. The durable history is its
      // only recovery input; resumed updates and terminal state still survive.
      yield* Effect.gen(function* () {
        const restartedSink = yield* EventSinkV2;
        yield* restartedSink.write({
          events: [item(4, "resumed"), item(5, "latest"), item(6, "interrupted", "cancelled")],
        });
      }).pipe(
        Effect.provide(
          eventSinkLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.fresh(eventStoreLayer).pipe(
                  Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
                ),
                Layer.succeed(ProjectionStoreV2, projections),
                Layer.succeed(SqlClient.SqlClient, sql),
              ),
            ),
          ),
        ),
      );
      assert.isTrue((yield* maintenance.rebuild).valid);
      const final = yield* projections.getThreadProjection(threadId);
      assert.equal(
        final.turnItems[0]?.type === "assistant_message" ? final.turnItems[0].text : null,
        "interrupted",
      );
    }).pipe(Effect.provide(services)),
);

it.effect(
  "keeps the first item anchor when its initial transaction rolls back and sequences are reused",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      const events = yield* EventStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const { threadId, created, item } = fixture("first-rollback", yield* DateTime.now);
      yield* sink.write({ events: [created] });
      yield* sql
        .withTransaction(
          sink
            .write({ events: [item(0, "uncommitted first"), item(1, "uncommitted second")] })
            .pipe(Effect.andThen(Effect.fail("rollback initial snapshots"))),
        )
        .pipe(Effect.result);
      // Reuse the cache's first sequence for a different item, then interleave
      // newer items before A's last update. Catch-up must introduce A before B.
      yield* sink.write({ events: [item(0, "unrelated", "completed", "c")] });
      const firstA = yield* sink.write({ events: [item(2, "committed first")] });
      yield* sink.write({ events: [item(0, "newer item", "completed", "b")] });
      yield* sink.write({ events: [item(3, "third"), item(4, "last", "completed")] });
      const replay = yield* events.read({ threadId }).pipe(Stream.runCollect);
      assert.isTrue(replay.some((stored) => stored.sequence === firstA[0]!.sequence));
      const itemOrder = replay
        .filter((stored) => stored.event.type === "turn-item.updated")
        .map((stored) => {
          assert.isTrue(stored.event.type === "turn-item.updated");
          return stored.event.type === "turn-item.updated" ? stored.event.payload.id : null;
        });
      assert.isBelow(
        itemOrder.indexOf(TurnItemId.make("item:first-rollback:a")),
        itemOrder.indexOf(TurnItemId.make("item:first-rollback:b")),
      );
    }).pipe(Effect.provide(services)),
);
