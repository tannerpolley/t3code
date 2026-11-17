import type {
  BackgroundPolicySnapshot,
  ServerSettings,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as BackgroundPolicy from "./BackgroundPolicy.ts";
import * as ServerSettingsService from "../serverSettings.ts";

type AwaySettings = Pick<ServerSettings, "awayMode" | "awayIdleMinutes">;

export function isAway(settings: AwaySettings, activity: BackgroundPolicySnapshot): boolean {
  if (settings.awayMode !== "auto") return settings.awayMode === "away";
  const webIsHere = activity.leases.some(
    (lease) =>
      lease.clientKind === "web" && BackgroundPolicy.isForegroundLease(lease, activity.updatedAt),
  );
  if (webIsHere) return false;
  const host = activity.hostPower;
  if (host.source === "electron-main" && !host.stale) {
    return (
      host.locked === "true" ||
      host.suspended ||
      (host.idleSeconds !== null && host.idleSeconds >= settings.awayIdleMinutes * 60)
    );
  }
  return true;
}

export function deferWaitingAlert(phase: string | undefined, away: boolean): boolean {
  return !away && (phase === "waiting_for_input" || phase === "waiting_for_approval");
}

export class AwayPolicy extends Context.Service<
  AwayPolicy,
  {
    readonly snapshot: Effect.Effect<boolean, ServerSettingsError>;
    readonly set: (
      patch: Partial<AwaySettings>,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
    readonly changes: Stream.Stream<boolean, ServerSettingsError>;
  }
>()("t3/background/AwayPolicy") {}

export const layer = Layer.effect(
  AwayPolicy,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService.ServerSettingsService;
    const background = yield* BackgroundPolicy.BackgroundPolicy;
    const snapshot = Effect.all([settings.getSettings, background.snapshot]).pipe(
      Effect.map(([current, activity]) => isAway(current, activity)),
    );
    return AwayPolicy.of({
      snapshot,
      set: Effect.fn("AwayPolicy.set")((patch) => settings.updateSettings(patch)),
      // Telemetry samples and foreground lease expiry both change Auto without a user action.
      changes: Stream.fromEffectSchedule(
        snapshot.pipe(Effect.retry({ schedule: Schedule.spaced("5 seconds") })),
        Schedule.spaced("5 seconds"),
      ).pipe(Stream.changes),
    });
  }),
);
