import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CheckpointScopeId, CommandId, IssueChangeError, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { layerExecutorFor, oldSessionId, providerThreadId, providerTurnId, runId, threadId } from "./EffectWorker.testHarness.ts";

it.effect(
  "isolates stalled and failing issue comments from lifecycle work and bounds retries",
  () =>
    Effect.gen(function* () {
      const marker = "<!-- t3-issue-closeout:github.com:1:2:thread:issue:run:1 -->";
      const started = yield* Deferred.make<void>();
      const failComment = yield* Deferred.make<void>();
      const executed = yield* Ref.make<ReadonlyArray<string>>([]);
      const workerLayer = EffectWorker.layerWithOptions({ maxAttempts: 2 }).pipe(
        Layer.provideMerge(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
        Layer.provide(
          Layer.succeed(
            EffectWorker.OrchestrationEffectExecutorV2,
            EffectWorker.OrchestrationEffectExecutorV2.of({
              execute: (effect) =>
                effect.request.type === "issue.github.comment"
                  ? Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Deferred.await(failComment)),
                      Effect.andThen(
                        Effect.fail(
                          new EffectWorker.OrchestrationEffectExecutionError({
                            effectId: effect.id,
                            effectType: effect.request.type,
                            cause: "GitHub token cannot comment",
                          }),
                        ),
                      ),
                    )
                  : Ref.update(executed, (current) => [...current, effect.id]),
            }),
          ),
        ),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* outbox.enqueue([
          {
            id: "effect:issue-closeout-retry",
            commandId: CommandId.make("command:issue-closeout-retry"),
            threadId,
            request: {
              type: "issue.github.comment",
              operation: "closeout_create",
              issue: {
                host: "github.com",
                repository: "owner/repo",
                repositoryId: "1",
                id: "2",
                nodeId: "I_kwDOIssue2",
                number: 8,
                url: "https://github.com/owner/repo/issues/8",
                title: "Retry comment",
              },
              writeKey: "issue-closeout:github.com:1:2:thread:issue:run:1",
              resultEventId: "run:1",
              marker,
              body: `Final result\n\n${marker}`,
            },
          },
        ]);

        yield* outbox.enqueue([
          {
            id: "effect:provider-start",
            commandId: CommandId.make("command:provider-start"),
            threadId,
            request: { type: "provider-turn.start", runId },
          },
        ]);
        const notification = yield* worker.awaitWorkInLane("issue-comment").pipe(Effect.forkScoped);
        yield* outbox.notifyAvailable();
        yield* Fiber.join(notification);
        const comment = yield* worker.runOnceInLane("issue-comment").pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        assert.isTrue(yield* worker.runOnceInLane("lifecycle"));
        assert.deepEqual(yield* Ref.get(executed), ["effect:provider-start"]);
        yield* Deferred.succeed(failComment, undefined);
        assert.isTrue(yield* Fiber.join(comment));
        const first = Option.getOrThrow(yield* outbox.get("effect:issue-closeout-retry"));
        assert.equal(first.status, "pending");
        assert.equal(first.attemptCount, 1);
        assert.isFalse(yield* worker.runOnceInLane("issue-comment"));
        yield* outbox.enqueue([
          {
            id: "effect:provider-interrupt",
            commandId: CommandId.make("command:provider-interrupt"),
            threadId,
            request: {
              type: "provider-turn.interrupt",
              providerSessionId: oldSessionId,
              providerThreadId,
              providerTurnId,
            },
          },
        ]);
        assert.isTrue(yield* worker.runOnceInLane("lifecycle"));
        yield* TestClock.adjust("100 millis");
        assert.isTrue(yield* worker.runOnceInLane("issue-comment"));
        const retried = Option.getOrThrow(yield* outbox.get("effect:issue-closeout-retry"));
        assert.equal(retried.status, "failed");
        assert.equal(retried.attemptCount, 2);
        yield* TestClock.adjust("1 minute");
        assert.isFalse(yield* worker.runOnceInLane("issue-comment"));
        assert.deepEqual(yield* Ref.get(executed), [
          "effect:provider-start",
          "effect:provider-interrupt",
        ]);
      }).pipe(Effect.provide(workerLayer));
    }),
);

it.effect("a stalled title cannot occupy the lifecycle worker lane", () =>
  Effect.gen(function* () {
    const titleStarted = yield* Deferred.make<void>();
    const stopTitle = yield* Deferred.make<void>();
    const executed = yield* Ref.make<ReadonlyArray<string>>([]);
    const workerLayer = EffectWorker.layerWithOptions().pipe(
      Layer.provideMerge(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      Layer.provide(
        Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
          execute: (effect) =>
            effect.request.type === "thread-title.generate"
              ? Deferred.succeed(titleStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(stopTitle)),
                )
              : Ref.update(executed, (current) => [...current, effect.id]),
        }),
      ),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* outbox.enqueue([
        ...Array.from({ length: 4 }, (_, i) => ({
          id: `effect:title:${i}`,
          commandId: CommandId.make(`command:title:${i}`),
          threadId: ThreadId.make(`thread:title:${i}`),
          request: {
            type: "thread-title.generate" as const,
            kind: { type: "regenerate" as const },
          },
        })),
        {
          id: "effect:checkpoint",
          commandId: CommandId.make("command:checkpoint"),
          threadId,
          request: {
            type: "checkpoint.capture",
            runId,
            scopeId: CheckpointScopeId.make("checkpoint-scope:test"),
          },
        },
        {
          id: "effect:start",
          commandId: CommandId.make("command:start"),
          threadId: ThreadId.make("thread:title:0"),
          request: { type: "provider-turn.start", runId },
        },
      ]);
      const titleNotification = yield* worker.awaitWorkInLane("title").pipe(Effect.forkScoped);
      const lifecycleNotification = yield* worker
        .awaitWorkInLane("lifecycle")
        .pipe(Effect.forkScoped);
      yield* outbox.notifyAvailable();
      yield* Fiber.join(titleNotification);
      yield* Fiber.join(lifecycleNotification);
      const titleFiber = yield* worker.runOnceInLane("title").pipe(Effect.forkScoped);
      yield* Deferred.await(titleStarted);
      assert.isTrue(yield* worker.runOnceInLane("lifecycle"));
      assert.isTrue(yield* worker.runOnceInLane("lifecycle"));
      assert.deepEqual(yield* Ref.get(executed), ["effect:checkpoint", "effect:start"]);
      const checkpoint = yield* outbox.get("effect:checkpoint");
      assert.equal(Option.getOrThrow(checkpoint).status, "succeeded");
      assert.isFalse(yield* worker.runOnceInLane("lifecycle"));
      assert.isTrue(Option.isNone(yield* outbox.nextClaimableAtInLane("lifecycle")));
      assert.isTrue(Option.isSome(yield* outbox.nextClaimableAtInLane("title")));
      yield* Deferred.succeed(stopTitle, undefined);
      assert.isTrue(yield* Fiber.join(titleFiber));
    }).pipe(Effect.provide(workerLayer));
  }),
);

it.effect(
  "issue changes execute through their service and retry no earlier than GitHub's deadline",
  () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const retryAt = DateTime.toEpochMillis(yield* DateTime.now) + 60_000;
      let calls = 0;
      const executor = layerExecutorFor({
        events,
        changes: {
          execute: () =>
            Effect.gen(function* () {
              calls++;
              if (calls === 1)
                return yield* new IssueChangeError({
                  code: "github",
                  message: "Rate limited",
                  retryAt,
                });
            }),
        },
      });
      const workerLayer = EffectWorker.layer.pipe(
        Layer.provideMerge(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
        Layer.provide(executor),
      );
      yield* Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* outbox.enqueue([
          {
            id: "change:rate-limit",
            commandId: CommandId.make("change:rate-limit"),
            threadId,
            request: { type: "issue.change.execute", changeId: "proposal" },
          },
        ]);
        assert.isTrue(yield* worker.runOnceInLane("issue-change"));
        assert.isFalse(yield* worker.runOnceInLane("issue-change"));
        const saved = yield* outbox.get("change:rate-limit");
        assert.isTrue(Option.isSome(saved));
        if (Option.isSome(saved))
          assert.equal(
            DateTime.toEpochMillis(DateTime.makeUnsafe(saved.value.availableAt)),
            retryAt,
          );
        yield* TestClock.adjust(60_000);
        assert.isTrue(yield* worker.runOnceInLane("issue-change"));
        assert.equal(calls, 2);
      }).pipe(Effect.provide(workerLayer));
    }),
);

it.effect("keeps a suspension's provider interrupt pending past the normal retry limit", () => {
  let failures = 2;
  const executor = Layer.succeed(
    EffectWorker.OrchestrationEffectExecutorV2,
    EffectWorker.OrchestrationEffectExecutorV2.of({
      execute: (effect, options) => {
        assert.isTrue(options?.willRetry);
        return failures-- > 0
          ? Effect.fail(
              new EffectWorker.OrchestrationEffectExecutionError({
                effectId: effect.id,
                effectType: effect.request.type,
                cause: "Injected provider interrupt failure",
              }),
            )
          : Effect.void;
      },
    }),
  );
  const layer = EffectWorker.layerWithOptions({ maxAttempts: 1 }).pipe(
    Layer.provideMerge(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    Layer.provide(executor),
    Layer.provide(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const effectId = "suspension-provider-interrupt";
    yield* outbox.enqueue([
      {
        id: effectId,
        commandId: CommandId.make(effectId),
        threadId,
        request: {
          type: "provider-turn.interrupt",
          retryUntilDone: true,
          providerSessionId: oldSessionId,
          providerThreadId,
          providerTurnId,
        },
      },
    ]);
    for (const delay of [0, 100, 200]) {
      if (delay > 0) yield* TestClock.adjust(delay);
      assert.isTrue(yield* worker.runOnce);
      const effect = Option.getOrThrow(yield* outbox.get(effectId));
      assert.equal(effect.status, failures >= 0 ? "pending" : "succeeded");
    }
    assert.equal(Option.getOrThrow(yield* outbox.get(effectId)).attemptCount, 3);
  }).pipe(Effect.provide(layer));
});
