import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";

const github = { provider: SourceControlProviderKind.make("github"), host: "github.com" };

it.effect("isolates cooldowns for verified credentials on the same host", () =>
  Effect.gen(function* () {
    const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
    yield* limits
      .recordRateLimit({ ...github, lease: 0 })
      .pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, "first"));
    yield* limits
      .check(github)
      .pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, "second"));
    const error = yield* limits
      .check(github)
      .pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, "first"), Effect.flip);
    assert.strictEqual(error._tag, "SourceControlRateLimitPausedError");
  }).pipe(Effect.provide(SourceControlRateLimit.layer)),
);

it("parses Retry-After seconds and HTTP dates", () => {
  assert.equal(SourceControlRateLimit.retryAtFromHeader("120", 1_000), 121_000);
  assert.equal(
    SourceControlRateLimit.retryAtFromHeader("Thu, 01 Jan 1970 00:02:01 GMT", 1_000),
    121_000,
  );
  assert.isUndefined(SourceControlRateLimit.retryAtFromHeader("later", 1_000));
});

it.effect("lets an interactive request through without clearing an active pause", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(1_000);
    const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
    const lease = yield* limits.check(github);
    yield* limits.recordRateLimit({ ...github, lease, retryAt: 121_000 });

    const interactiveLease = yield* limits.check(github, { allowPaused: true });
    yield* limits.recordSuccess({ ...github, lease: interactiveLease });

    assert.equal(interactiveLease, 1);
    assert.equal((yield* Effect.flip(limits.check(github))).retryAt, 121_000);

    yield* limits.recordRateLimit({ ...github, lease: interactiveLease, retryAt: 61_000 });
    assert.equal((yield* Effect.flip(limits.check(github))).retryAt, 121_000);
  }).pipe(Effect.provide(SourceControlRateLimit.layer)),
);

it.effect("keeps providers and hosts isolated", () =>
  Effect.gen(function* () {
    const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
    const lease = yield* limits.check(github);
    yield* limits.recordRateLimit({ ...github, lease });

    assert.equal(
      yield* limits.check({
        provider: SourceControlProviderKind.make("gitlab"),
        host: "github.com",
      }),
      0,
    );
    assert.equal(
      yield* limits.check({
        provider: SourceControlProviderKind.make("github"),
        host: "github.example.com",
      }),
      0,
    );
  }).pipe(Effect.provide(SourceControlRateLimit.layer)),
);

it.effect("does not let an older success clear a concurrent pause", () =>
  Effect.gen(function* () {
    const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
    const firstLease = yield* limits.check(github);
    const concurrentLease = yield* limits.check(github);

    yield* limits.recordRateLimit({ ...github, lease: firstLease });
    yield* limits.recordSuccess({ ...github, lease: concurrentLease });

    assert.equal((yield* Effect.flip(limits.check(github))).retryAt, 30_000);
  }).pipe(Effect.provide(SourceControlRateLimit.layer)),
);

it.effect("keeps a fresh provider reset from an older request", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
    const staleLease = yield* limits.check(github);
    yield* limits.recordRateLimit({ ...github, lease: staleLease });

    yield* TestClock.adjust("31 seconds");
    yield* limits.recordRateLimit({ ...github, lease: staleLease, retryAt: 61_000 });

    assert.equal((yield* Effect.flip(limits.check(github))).retryAt, 61_000);
  }).pipe(Effect.provide(SourceControlRateLimit.layer)),
);

it.effect("logs each recorded refusal with response details and the resulting pause deadline", () =>
  Effect.gen(function* () {
    const messages: unknown[] = [];
    const logger = Logger.make(({ message, logLevel }) => {
      messages.push({ message, logLevel });
    });
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
      const response = {
        operation: "listIssues",
        method: "GET",
        path: "/repos/acme/app/issues",
        status: 403,
        headers: {
          "x-ratelimit-resource": "core",
          "x-ratelimit-remaining": "4321",
          "x-ratelimit-reset": "60",
          "retry-after": "30",
          authorization: "secret",
        },
      };
      yield* limits.recordRateLimit({ ...github, lease: 0, response });
      yield* limits.recordRateLimit({ ...github, lease: 1, retryAt: 2_000, response });
      assert.deepEqual(
        messages,
        [31_000, 31_000].map((retryAt) => ({
          logLevel: "Warn",
          message: [
            "Source control rate limit recorded",
            JSON.stringify({
              provider: "github",
              host: "github.com",
              operation: "listIssues",
              method: "GET",
              path: "/repos/acme/app/issues",
              status: 403,
              "x-ratelimit-resource": "core",
              "x-ratelimit-remaining": "4321",
              "x-ratelimit-reset": "60",
              "retry-after": "30",
              retryAt,
            }),
          ],
        })),
      );
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  }).pipe(Effect.provide(SourceControlRateLimit.layer)),
);
