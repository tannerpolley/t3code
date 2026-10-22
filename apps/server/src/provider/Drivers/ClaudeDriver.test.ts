// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ServerProvider,
  type ResetCreditAutoUseResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ClaudeAgentSdkQueryRunner } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ClaudeResetCredits from "../claudeResetCredits.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import * as ResetCreditExpiry from "../ResetCreditExpiry.ts";
import * as ProviderRegistry from "../ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "../ProviderInstanceRegistry.ts";
import * as UsageLimitSources from "../../usage/UsageLimitSources.ts";

const layerTest = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-credit-race-" }),
  ServerSettings.layerTest(),
  ResetCreditCoordinator.layerTest,
  ProviderLatestVersions.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  Layer.mock(ClaudeAgentSdkQueryRunner)({
    allocateSessionId: Effect.die("Credit redemption must not allocate a conversation"),
    assertComplete: Effect.void,
  }),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.mock(ProviderHost.ProviderHost)({
    paths: {
      cwd: "unused",
      baseDir: "unused",
      stateDir: "unused",
      providerStatusCacheDir: "unused",
      attachmentsDir: "unused",
    },
    resolveAttachmentPath: () => null,
    settings: {
      get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      changes: Stream.empty,
      subscribe: Effect.succeed(Stream.empty),
      withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
    },
  }),
).pipe(Layer.provideMerge(NodeServices.layer));
const creditFixture = Effect.fn("ClaudeDriverTest.creditFixture")(function* () {
  const requests: unknown[] = [];
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const homePath = NodePath.join(config.stateDir, "credit-home");
  yield* fs.makeDirectory(homePath, { recursive: true });
  yield* fs.writeFileString(
    NodePath.join(homePath, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "fake" } }),
  );
  const account = yield* ClaudeResetCredits.claudeAccountConfigPath(homePath);
  yield* fs.writeFileString(
    account,
    JSON.stringify({ oauthAccount: { organizationUuid: "org-test" } }),
  );
  const decodeConsume = Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ grant_id: Schema.String })),
  );
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("unexpected body");
      const body = yield* decodeConsume(new TextDecoder().decode(request.body.body)).pipe(
        Effect.orDie,
      );
      requests.push({ creditId: body.grant_id });
      return HttpClientResponse.fromWeb(request, Response.json({ result: "reset" }));
    }),
  );
  const instance = yield* ClaudeDriver.create({
    instanceId: ProviderInstanceId.make("claude-round4"),
    displayName: undefined,
    enabled: false,
    environment: [],
    config: { ...ClaudeDriver.defaultConfig(), homePath, binaryPath: process.execPath },
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
  const base = yield* instance.snapshot.getSnapshot;
  const current = yield* Ref.make({
    ...base,
    version: "2.1.0",
    auth: { status: "authenticated" as const, email: "fake@example.com" },
    usageLimits: {
      checkedAt: "2026-10-22T12:00:00.000Z",
      windows: [],
      resetCredits: {
        availableCount: 2,
        nextCreditId: "credit-a",
        nextExpiresAt: "1970-01-01T00:20:00.000Z",
      },
    },
  });
  Object.assign(instance.snapshot, {
    getSnapshot: Ref.get(current),
    refresh: Ref.updateAndGet(current, (v) => ({
      ...v,
      usageLimits: {
        ...v.usageLimits,
        checkedAt: DateTime.formatIso(
          DateTime.add(DateTime.makeUnsafe(v.usageLimits.checkedAt), { minutes: 1 }),
        ),
        resetCredits: {
          availableCount: 1,
          nextCreditId: "credit-b",
          nextExpiresAt: "1970-01-01T00:30:00.000Z",
        },
      },
    })),
  });
  return { instance, requests, current };
});
const claudeLayer = layerTest.pipe(
  Layer.provideMerge(
    Layer.mock(ModelCatalog.ModelCatalog)({
      bundled: () => undefined,
      current: () => Effect.succeed(undefined),
      refreshInBackground: Effect.void,
    }),
  ),
);
it.layer(claudeLayer)("ClaudeDriver", (it) => {
  it.effect(
    "does not abandon A after selection changes to B while queued and then returns to A",
    () =>
      Effect.gen(function* () {
        const minute = 60_000;
        const f = yield* creditFixture();
        yield* Ref.update(f.current, (value) => ({ ...value, enabled: true }));
        const refresh = f.instance.snapshot.refresh;
        Object.assign(f.instance.snapshot, {
          refresh: Effect.suspend(() => (f.requests.length ? refresh : Ref.get(f.current))),
        });
        const coordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
        const config = yield* ServerConfig.ServerConfig;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const queued = yield* Deferred.make<void>();
        const notices: ResetCreditAutoUseResult[] = [];
        const holder = yield* coordinator
          .redeem(NodePath.join(config.stateDir, "credit-home"), () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return "nothingToReset" as const;
            }),
          )
          .pipe(Effect.orDie, Effect.forkChild);
        yield* Deferred.await(entered);
        const updates = yield* PubSub.unbounded<readonly ServerProvider[]>();
        const ready = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const deps = Layer.mergeAll(
          ServerSettings.layerTest({ autoUseExpiringResetCredits: true }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Ref.get(f.current).pipe(Effect.map((value) => [value])),
            subscribeChanges: Effect.succeed(
              Stream.unwrap(
                Effect.gen(function* () {
                  const subscription = yield* PubSub.subscribe(updates);
                  yield* Deferred.succeed(ready, undefined);
                  return Stream.concat(
                    Stream.fromEffect(Ref.get(f.current).pipe(Effect.map((value) => [value]))),
                    Stream.fromSubscription(subscription),
                  );
                }),
              ),
            ),
            refreshInstance: () => f.instance.snapshot.refresh.pipe(Effect.map((value) => [value])),
            publishResetCreditAutoUse: (_id, _account, result) =>
              Effect.sync(() => {
                notices.push(result);
              }),
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: () =>
              Effect.succeed({
                ...f.instance,
                enabled: true,
                consumeResetCredit: (expected, canRedeem) =>
                  Deferred.succeed(queued, undefined).pipe(
                    Effect.andThen(f.instance.consumeResetCredit!(expected, canRedeem)),
                    Effect.tap(() => Deferred.succeed(completed, undefined)),
                  ),
              }),
          }),
          Layer.mock(UsageLimitSources.UsageLimitSources)({
            current: Effect.succeed([]),
            streamChanges: Stream.make([]),
          }),
        );
        const scheduler = yield* ResetCreditExpiry.ResetCreditExpiry.pipe(
          Effect.provide(ResetCreditExpiry.layer.pipe(Layer.provide(deps))),
        );
        yield* scheduler.start;
        yield* Deferred.await(ready);
        yield* TestClock.adjust(10 * minute);
        yield* Deferred.await(queued);
        yield* Ref.update(f.current, (value) => ({
          ...value,
          usageLimits: {
            ...value.usageLimits!,
            resetCredits: {
              availableCount: 2,
              expiries: ["1970-01-01T00:20:00.000Z", "1970-01-01T00:30:00.000Z"],
              nextCreditId: "credit-b",
              nextExpiresAt: "1970-01-01T00:30:00.000Z",
            },
          },
        }));
        yield* PubSub.publish(updates, [yield* Ref.get(f.current)]);
        yield* TestClock.adjust(0);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        yield* Deferred.await(completed);
        expect(f.requests).toHaveLength(0);
        yield* TestClock.adjust(0);
        expect(notices).toEqual([]);
        yield* Ref.update(f.current, (v) => ({
          ...v,
          usageLimits: {
            ...v.usageLimits,
            resetCredits: {
              availableCount: 2,
              nextCreditId: "credit-a",
              nextExpiresAt: "1970-01-01T00:20:00.000Z",
            },
          },
        }));
        yield* PubSub.publish(updates, [yield* Ref.get(f.current)]);
        yield* TestClock.adjust(9 * minute);
        expect(f.requests).toContainEqual(expect.objectContaining({ creditId: "credit-a" }));
      }).pipe(Effect.scoped),
  );
});
