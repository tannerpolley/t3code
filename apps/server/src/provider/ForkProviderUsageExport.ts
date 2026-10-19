import { EnvironmentId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { isUsageWindowStale } from "@t3tools/shared/forkUsageLimits";
import { collectLimitAccounts, collectLimitPools } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const encodeUsageExport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class ForkProviderUsageExport extends Context.Service<
  ForkProviderUsageExport,
  {
    readonly write: Effect.Effect<void>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/provider/ForkProviderUsageExport") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const lock = yield* Semaphore.make(1);
  const filePath = path.join(config.stateDir, "provider-usage-limits.json");
  let previous: unknown;

  const write = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const providers = yield* registry.getProviders;
    const usageLimitSources = yield* sources.current;
    const pools = collectLimitPools(
      collectLimitAccounts(
        new Map([
          [
            EnvironmentId.make("local"),
            {
              entry: { target: { label: "Local" } },
              serverConfig: { providers, usageLimitSources },
            },
          ],
        ]),
      ),
      nowMs,
    );
    const readings = (["claudeAgent", "codex"] as const).flatMap((driver) => {
      const pool = pools.find((candidate) => candidate.driver === driver);
      if (!pool) return [];
      const windowReading = (kind: "weekly" | "session") => {
        const window = pool.windows.find(
          (candidate) =>
            candidate.kind === kind &&
            (driver !== "claudeAgent" || kind !== "weekly" || candidate.id === "seven_day"),
        );
        if (!window) return null;
        const nextReset = window.resets[0]?.at;
        return {
          leftPercent: Math.max(0, Math.min(100, window.remainingPercent)),
          resetsAt:
            nextReset === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(nextReset)),
          stale: window.members.some((member) => isUsageWindowStale(member.window, nowMs)),
        };
      };
      return [
        {
          driver,
          label: driver === "claudeAgent" ? "Claude" : "Codex",
          checkedAt: pool.accounts.map((account) => account.limits.checkedAt).sort()[0]!,
          weekly: windowReading("weekly"),
          session: windowReading("session"),
        },
      ];
    });
    // writtenAt describes a changed reading, not every unrelated provider event.
    if (Equal.equals(readings, previous)) return;
    const contents = yield* encodeUsageExport({
      version: 1,
      writtenAt: DateTime.formatIso(now),
      providers: readings,
    });
    yield* writeFileStringAtomically({
      filePath,
      contents: `${contents}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    previous = readings;
  }).pipe(
    lock.withPermits(1),
    Effect.catch((error) =>
      Effect.logWarning("could not write taskbar provider usage limits", {
        path: filePath,
        errorTag: error._tag,
      }),
    ),
  );

  const start = Effect.gen(function* () {
    const changes = yield* Stream.toPull(
      Stream.merge(
        registry.streamChanges.pipe(Stream.map(() => undefined)),
        sources.streamChanges.pipe(Stream.map(() => undefined)),
      ),
    );
    yield* write;
    yield* Stream.fromPull(Effect.succeed(changes)).pipe(
      Stream.runForEach(() => write),
      Effect.forkScoped,
    );
    // Normal health checks need client demand; the taskbar also needs readings with no client open.
    yield* Effect.forever(
      Effect.sleep("5 minutes").pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const providers = yield* registry.getProviders;
            yield* Effect.forEach(
              providers.filter(
                (provider) =>
                  provider.enabled &&
                  provider.installed &&
                  (provider.driver === "claudeAgent" || provider.driver === "codex"),
              ),
              (provider) => registry.refreshInstance(provider.instanceId),
              { discard: true },
            );
            yield* sources.refresh;
          }),
        ),
        Effect.andThen(write),
      ),
    ).pipe(Effect.forkScoped);
  });

  return ForkProviderUsageExport.of({ write, start });
});

export const layer = Layer.effect(ForkProviderUsageExport, make);
