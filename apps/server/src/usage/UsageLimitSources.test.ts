import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ServerConfigStreamEvent, UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ResetCreditExpiry from "../provider/ResetCreditExpiry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

it.effect(
  "reschedules auto-use from the selected credit published by an in-flight hub refresh",
  () =>
    Effect.gen(function* () {
      const minute = 60_000;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const queued = yield* Deferred.make<void>();
      const completed = yield* Queue.unbounded<void>();
      const ready = yield* Deferred.make<void>();
      const credit = (id: string, minutes: number) => ({
        id,
        expires_at: DateTime.formatIso(DateTime.makeUnsafe(minutes * minute)),
        status: "available",
        reset_type: "codex_rate_limits",
      });
      let remote = [credit("credit-a", 20)];
      let pause = false;
      const requests: { creditId: string; at: number }[] = [];
      const decodeRequest = Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({ url: Schema.String, data: Schema.optional(Schema.String) }),
        ),
      );
      const decodeConsume = Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ credit_id: Schema.String })),
      );
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          const path = new URL(request.url).pathname;
          if (path.endsWith("/auth-files"))
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                files: [
                  {
                    id: "account.json",
                    auth_index: "a",
                    provider: "codex",
                    email: "a@example.com",
                    id_token: { chatgpt_account_id: "account-a" },
                  },
                ],
              }),
            );
          if (path.endsWith("/reset-quota"))
            return HttpClientResponse.fromWeb(request, Response.json({}));
          const body =
            request.body._tag === "Uint8Array"
              ? yield* decodeRequest(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie)
              : undefined;
          let response: unknown = { plan_type: "pro", rate_limit: null };
          if (body?.url.endsWith("/rate-limit-reset-credits")) {
            response = { credits: remote };
            if (pause) {
              pause = false;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
          }
          if (body?.url.endsWith("/consume")) {
            const data = yield* decodeConsume(body.data!).pipe(Effect.orDie);
            requests.push({ creditId: data.credit_id, at: yield* Clock.currentTimeMillis });
            remote = remote.filter((credit) => credit.id !== data.credit_id);
            response = { code: "reset" };
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ status_code: 200, body: JSON.stringify(response) }),
          );
        }),
      );
      const sources = yield* UsageLimitSources.make.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      yield* sources.refresh;
      const deps = Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          subscribeChanges: Effect.succeed(Stream.make([])),
          getProviders: Effect.succeed([]),
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed(undefined),
        }),
        Layer.succeed(UsageLimitSources.UsageLimitSources, {
          ...sources,
          streamChanges: sources.streamChanges.pipe(
            Stream.tap(() => Deferred.succeed(ready, undefined)),
          ),
          consumeResetCredit: (input, canRedeem) =>
            Deferred.succeed(queued, undefined).pipe(
              Effect.andThen(sources.consumeResetCredit(input, canRedeem)),
              Effect.tap(() => Queue.offer(completed, undefined)),
            ),
        }),
      );
      const scheduler = yield* ResetCreditExpiry.ResetCreditExpiry.pipe(
        Effect.provide(ResetCreditExpiry.layer.pipe(Layer.provide(deps))),
      );
      yield* scheduler.start;
      yield* Deferred.await(ready);
      yield* TestClock.adjust(10 * minute - 1);
      remote = [credit("credit-b", 30), credit("credit-a", 40)];
      pause = true;
      const refresh = yield* sources.refresh.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(1);
      yield* Deferred.await(queued);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(refresh);
      yield* Queue.take(completed);
      expect((yield* sources.current)[0]?.accounts[0]?.usageLimits.resetCredits?.nextCreditId).toBe(
        "credit-b",
      );
      expect(requests).toHaveLength(0);
      yield* TestClock.adjust(10 * minute - 1);
      expect(requests).toHaveLength(0);
      yield* TestClock.adjust(1);
      yield* Queue.take(completed);
      expect(requests).toEqual([{ creditId: "credit-b", at: 20 * minute }]);
    }).pipe(
      Effect.provide([
        ServerSettings.layerTest({
          autoUseExpiringResetCredits: true,
          usageLimitSources: {
            [UsageLimitSourceId.make("hub")]: {
              kind: "cliproxy",
              url: "http://hub.test:8317",
              managementKey: "fake-key",
              enabled: true,
            },
          },
        }),
        NodeCrypto.layer,
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
      ]),
      Effect.scoped,
    ),
);
