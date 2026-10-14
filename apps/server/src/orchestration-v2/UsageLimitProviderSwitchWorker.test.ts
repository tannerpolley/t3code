import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as SwitchWorker from "./UsageLimitProviderSwitchWorker.ts";

it.effect.each(["off", "wait", "switch"] as const)(
  "sweep only queries recent children in Switch mode: %s",
  (mode) => {
    const calls: string[] = [];
    const record = (name: string) =>
      Effect.sync(() => {
        calls.push(name);
        return [];
      });
    return Effect.gen(function* () {
      yield* (yield* SwitchWorker.UsageLimitProviderSwitchWorker).sweep;
      assert.deepEqual(calls, mode === "switch" ? ["recent-children", "switch-candidates"] : []);
    }).pipe(
      Effect.provide(
        SwitchWorker.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ServerSettings.layerTest({ usageLimitRecovery: mode }),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getRecentUsageLimitChildren: () => record("recent-children"),
                getLimitRecoveryCandidates: () => record("switch-candidates"),
                getRecoveryThreadIds: () => record("full-recovery"),
              }),
              Layer.mock(Orchestrator.OrchestratorV2)({
                recoverDelegatedTasks: record("startup-recovery").pipe(Effect.asVoid),
                recoverDelegatedTask: () => record("child-recovery").pipe(Effect.asVoid),
              }),
              Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
              Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
              Layer.mock(ThreadManagement.ThreadManagementService)({}),
            ),
          ),
        ),
      ),
    );
  },
);
