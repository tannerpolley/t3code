import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as IssueWorkStore from "./IssueWorkStore.ts";

const dependencies = Layer.mergeAll(IssueWorkStore.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
it.effect(
  "publishing reflects durable pending, failed, succeeded and cancelled outbox states",
  () =>
    Effect.gen(function* () {
      const store = yield* IssueWorkStore.IssueWorkStore;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("publishing-test");
      assert.equal(yield* store.publishing(threadId), "absent");
      yield* outbox.enqueue([
        {
          id: "publishing-test-effect",
          commandId: CommandId.make("publishing-test-command"),
          threadId,
          request: {
            type: "issue.github.comment",
            operation: "status_sync",
            issue: {
              host: "github.com",
              repository: "tannerpolley/t3code",
              repositoryId: "repo",
              id: "issue",
              nodeId: "node",
              number: 8,
              title: "Test",
              url: "https://github.com/tannerpolley/t3code/issues/8",
            },
            writeKey: "publishing-test-key",
            marker: "<!-- marker -->",
            body: "Working",
          },
        },
      ]);
      assert.equal(yield* store.publishing(threadId), "pending");
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'failed', last_error = 'rate limited' WHERE effect_id = 'publishing-test-effect'`;
      assert.equal(yield* store.publishing(threadId), "failed");
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded', last_error = NULL WHERE effect_id = 'publishing-test-effect'`;
      assert.equal(yield* store.publishing(threadId), "published");
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'cancelled' WHERE effect_id = 'publishing-test-effect'`;
      assert.equal(yield* store.publishing(threadId), "absent");
    }).pipe(Effect.provide(dependencies)),
);
