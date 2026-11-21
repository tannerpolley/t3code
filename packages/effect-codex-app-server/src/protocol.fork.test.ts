import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import * as TestClock from "effect/testing/TestClock";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";

import { makeInMemoryStdio } from "./_internal/stdio.ts";
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const encoder = new TextEncoder();

const encodeJsonl = (value: unknown) => encoder.encode(`${encodeUnknownJsonString(value)}\n`);

it.layer(NodeServices.layer)("effect-codex-app-server protocol", (it) => {
  it.effect("settles each unanswered request and accepts new work after a late reply", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });
      const requests = [];
      for (const method of ["thread/unsubscribe", "turn/start", "turn/steer"]) {
        requests.push(
          yield* transport.request(method, { threadId: "native-thread" }).pipe(
            Effect.match({
              onFailure: (error) => error,
              onSuccess: () => assert.fail("Expected request failure"),
            }),
            Effect.forkScoped,
          ),
        );
        yield* Queue.take(output);
      }
      yield* TestClock.adjust("60 seconds");
      for (const [index, request] of requests.entries()) {
        const error = yield* Fiber.join(request);
        assert.instanceOf(error, CodexError.CodexAppServerRequestTimeoutError);
        assert.equal(error.requestId, index + 1);
      }
      const next = yield* transport.request("thread/resume", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offerAll(input, [
        encodeJsonl({ id: 1, result: { status: "unsubscribed" } }),
        encodeJsonl({ id: 4, result: { thread: { id: "resumed" } } }),
      ]);
      assert.deepEqual(yield* Fiber.join(next), { thread: { id: "resumed" } });
    }),
  );

  it.effect("fails pending requests when a notification handler defects", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onNotification: () => Effect.die(new Error("notification handler failed")),
      });
      const pending = yield* transport.request("thread/unsubscribe", {}).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected request failure"),
        }),
        Effect.forkScoped,
      );
      yield* Queue.take(output);
      yield* Queue.offer(input, encodeJsonl({ method: "item/started", params: {} }));
      const error = yield* Fiber.join(pending);
      assert.instanceOf(error, CodexError.CodexAppServerTransportError);
      assert.equal(error.operation, "read-input-stream");
      assert.include(String(error.cause), "notification handler failed");
    }),
  );
});
