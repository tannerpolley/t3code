import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as ForkProviderUsageExport from "./ForkProviderUsageExport.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const now = "2026-10-19T12:00:00.000Z";
const later = "2026-10-20T12:00:00.000Z";
const olderCheck = "2026-10-19T11:00:00.000Z";

function provider(
  instanceId: string,
  driver: "claudeAgent" | "codex",
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  checkedAt = now,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: `${instanceId}@example.com` },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt, windows },
  };
}

const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 10,
  resetsAt: later,
} as const;
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 20,
} as const;

it.effect(
  "exports pooled readings only on change, retries failed writes, and refreshes without clients",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const claude = provider("claude-a", "claudeAgent", [
        { ...weekly, id: "seven_day_opus", usedPercent: 99 },
        weekly,
        session,
      ]);
      const records = yield* Ref.make<ReadonlyArray<ServerProvider>>([
        claude,
        provider(
          "claude-b",
          "claudeAgent",
          [
            { ...weekly, usedPercent: 40, resetsAt: "2026-10-22T12:00:00.000Z" },
            { ...session, usedPercent: 61, resetsAt: olderCheck },
          ],
          olderCheck,
        ),
        // Another instance for the first account must not add quota to the pool.
        { ...claude, instanceId: ProviderInstanceId.make("claude-duplicate") },
        provider("codex", "codex", [{ ...weekly, id: "primary", usedPercent: 100 }]),
      ]);
      const refreshed = yield* Deferred.make<void>();
      const refreshes: ProviderInstanceId[] = [];
      let writes = 0;
      const exporter = yield* ForkProviderUsageExport.ForkProviderUsageExport.pipe(
        Effect.provide(
          ForkProviderUsageExport.layer.pipe(
            Layer.provide([
              Layer.mock(ProviderRegistry.ProviderRegistry)({
                getProviders: Ref.get(records),
                streamChanges: Stream.never,
                refreshInstance: (instanceId) =>
                  Effect.sync(() => refreshes.push(instanceId)).pipe(
                    Effect.andThen(Ref.get(records)),
                  ),
              }),
              Layer.mock(UsageLimitSources.UsageLimitSources)({
                current: Effect.succeed([]),
                streamChanges: Stream.never,
                refresh: Deferred.succeed(refreshed, undefined).pipe(Effect.asVoid),
              }),
              Layer.succeed(FileSystem.FileSystem, {
                ...fs,
                writeFileString: (...args) => {
                  writes++;
                  return fs.writeFileString(...args);
                },
              }),
            ]),
          ),
        ),
      );
      const filePath = `${config.stateDir}/provider-usage-limits.json`;
      yield* exporter.write;
      const contents = yield* fs.readFileString(filePath);
      expect(JSON.parse(contents)).toEqual({
        version: 1,
        writtenAt: now,
        providers: [
          {
            driver: "claudeAgent",
            label: "Claude",
            checkedAt: olderCheck,
            weekly: { leftPercent: 75, resetsAt: later, stale: false },
            session: { leftPercent: 60, resetsAt: olderCheck, stale: true },
          },
          {
            driver: "codex",
            label: "Codex",
            checkedAt: now,
            weekly: { leftPercent: 0, resetsAt: later, stale: false },
            session: null,
          },
        ],
      });
      yield* TestClock.adjust("1 minute");
      yield* exporter.write;
      expect(writes).toBe(1);
      expect(yield* fs.readFileString(filePath)).toBe(contents);

      yield* Ref.set(records, [provider("codex", "codex", [])]);
      // A blocked destination must neither fail the caller nor mark the new reading as saved.
      yield* fs.remove(filePath);
      yield* fs.makeDirectory(filePath);
      yield* exporter.write;
      expect((yield* fs.stat(filePath)).type).toBe("Directory");
      yield* fs.remove(filePath, { recursive: true });
      yield* exporter.write;
      expect(JSON.parse(yield* fs.readFileString(filePath))).toEqual({
        version: 1,
        writtenAt: "2026-10-19T12:01:00.000Z",
        providers: [],
      });
      expect(writes).toBe(3);
      expect(yield* fs.readDirectory(config.stateDir)).not.toContainEqual(
        expect.stringContaining("provider-usage-limits.json."),
      );

      yield* Ref.set(records, [claude, provider("codex", "codex", [weekly])]);
      yield* exporter.start;
      expect(refreshes).toEqual([]);
      yield* TestClock.adjust("5 minutes");
      yield* Deferred.await(refreshed);
      expect(refreshes).toEqual(["claude-a", "codex"]);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest("/tmp", { prefix: "t3-provider-usage-export-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
);
