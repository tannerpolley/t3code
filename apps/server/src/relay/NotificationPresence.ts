import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import type { NotificationPresence as Presence } from "@t3tools/contracts";
import { isTailscaleIpv4Address, probeTailnetPeer } from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerSettings from "../serverSettings.ts";

export const PRESENCE_REFRESH_MS = 15_000;
const tailscaleV6 = new NodeNet.BlockList();
tailscaleV6.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

function isTailnetAddress(address: string) {
  return isTailscaleIpv4Address(address) || tailscaleV6.check(address, "ipv6");
}

function isLanEndpoint(
  endpoint: string | null,
  interfaces: ReturnType<typeof NodeOS.networkInterfaces>,
) {
  if (endpoint === null) return false;
  const address = endpoint.split("%")[0] ?? "";
  const version = NodeNet.isIP(address);
  if (version === 0 || isTailnetAddress(address)) return false;
  const family = version === 4 ? "ipv4" : "ipv6";
  const local = new NodeNet.BlockList();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || !entry.cidr || isTailnetAddress(entry.address)) continue;
      if (entry.family !== (version === 4 ? "IPv4" : "IPv6")) continue;
      const prefix = Number(entry.cidr.split("/")[1]);
      if (prefix > 0) local.addSubnet(entry.address, prefix, family);
    }
  }
  return local.check(address, family);
}

export class NotificationPresence extends Context.Service<
  NotificationPresence,
  { readonly read: () => Effect.Effect<Presence> }
>()("t3/relay/NotificationPresence") {}

export const layerWithProbe = <E>(
  probe: (peer: string) => Effect.Effect<string | null, E>,
  interfaces: typeof NodeOS.networkInterfaces,
) =>
  Layer.effect(
    NotificationPresence,
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const lock = yield* Semaphore.make(1);
      let cached:
        | {
            peer: string;
            result: "home" | "away";
            lan: boolean;
            expiresAt: number;
          }
        | undefined;
      const read = Effect.fn("NotificationPresence.read")(function* () {
        const peer = yield* settings.getSettings.pipe(
          Effect.map((value) => value.notificationPresencePeer),
          Effect.orElseSucceed(() => null),
        );
        if (peer === null) {
          cached = undefined;
          return "away" as const;
        }
        if (peer === "") {
          cached = undefined;
          return "off" as const;
        }
        const previous = cached?.peer === peer ? cached : undefined;
        const now = yield* Clock.currentTimeMillis;
        if (previous && now < previous.expiresAt) return previous.result;
        const lan = yield* probe(peer).pipe(
          Effect.map((endpoint) => isLanEndpoint(endpoint, interfaces())),
          Effect.catchCause(() => Effect.succeed(false)),
        );
        // Fail over immediately. After an away reading, require two LAN readings to return home.
        const result = lan && (previous === undefined || previous.lan) ? "home" : "away";
        cached = {
          peer,
          result,
          lan,
          expiresAt: (yield* Clock.currentTimeMillis) + PRESENCE_REFRESH_MS,
        };
        return result;
      }, lock.withPermits(1));
      return NotificationPresence.of({ read });
    }),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = yield* HostProcess.Platform;
    return layerWithProbe(
      (peer) =>
        probeTailnetPeer(peer).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcess.Platform, platform),
        ),
      NodeOS.networkInterfaces,
    );
  }),
);
