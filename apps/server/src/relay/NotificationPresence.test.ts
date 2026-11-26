import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSettings from "../serverSettings.ts";
import * as NotificationPresence from "./NotificationPresence.ts";

const interfaces = () => ({
  enp42s0: [
    {
      address: "10.0.0.15",
      netmask: "255.255.255.0",
      family: "IPv4" as const,
      mac: "",
      internal: false,
      cidr: "10.0.0.15/24",
    },
  ],
});

const layer = <E>(probe: () => Effect.Effect<string | null, E>, peer = "pixel-9") =>
  NotificationPresence.layerWithProbe(probe, interfaces).pipe(
    Layer.provide(ServerSettings.layerTest({ notificationPresencePeer: peer })),
  );

describe("NotificationPresence", () => {
  it.effect.each([
    { endpoint: "10.0.0.72", expected: "home" },
    { endpoint: "10.0.1.72", expected: "away" },
    { endpoint: "100.70.9.108", expected: "away" },
    { endpoint: null, expected: "away" },
  ])("classifies direct endpoint $endpoint as $expected", ({ endpoint, expected }) =>
    Effect.gen(function* () {
      const presence = yield* NotificationPresence.NotificationPresence;
      expect(yield* presence.read()).toBe(expected);
    }).pipe(Effect.provide(layer(() => Effect.succeed(endpoint)))),
  );

  it.effect("routes probe failures to the phone", () =>
    Effect.gen(function* () {
      const presence = yield* NotificationPresence.NotificationPresence;
      expect(yield* presence.read()).toBe("away");
    }).pipe(Effect.provide(layer(() => Effect.fail("tailscale unavailable")))),
  );

  it.effect("leaves routing off without probing if the phone is unset", () =>
    Effect.gen(function* () {
      const presence = yield* NotificationPresence.NotificationPresence;
      expect(yield* presence.read()).toBe("off");
    }).pipe(
      Effect.provide(
        layer(() => {
          throw new Error("Unexpected probe");
        }, ""),
      ),
    ),
  );

  it.effect("shares a cached probe and requires two LAN readings to return from away", () => {
    let endpoint: string | null = null;
    let probes = 0;
    return Effect.gen(function* () {
      const presence = yield* NotificationPresence.NotificationPresence;
      expect(yield* Effect.all([presence.read(), presence.read()], { concurrency: 2 })).toEqual([
        "away",
        "away",
      ]);
      expect(probes).toBe(1);
      endpoint = "10.0.0.72";
      yield* TestClock.adjust("15 seconds");
      expect(yield* presence.read()).toBe("away");
      yield* TestClock.adjust("15 seconds");
      expect(yield* presence.read()).toBe("home");
      endpoint = null;
      yield* TestClock.adjust("15 seconds");
      expect(yield* presence.read()).toBe("away");
      expect(probes).toBe(4);
    }).pipe(
      Effect.provide(
        layer(() =>
          Effect.sync(() => {
            probes += 1;
            return endpoint;
          }),
        ),
      ),
    );
  });
});
