import { AssetWorkspaceAssetInspectionError } from "@t3tools/contracts";
import { AssetWorkspaceContextNotFoundError } from "@t3tools/contracts";
import { EnvironmentAuthorizationError } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";
import { AtomRegistry } from "effect/reactivity";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import { PrimaryConnectionTarget } from "../connection/model.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { SupervisorConnectionState } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { createAssetEnvironmentAtoms } from "./assets.ts";
import { describe, expect, it } from "@effect/vitest";
import { AssetWorkspaceAssetNotFoundError, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { AsyncResult } from "effect/reactivity";

import { assetUrlStateFromResult } from "./assets.ts";

describe("asset URL failures", () => {
  it("preserves signing errors and explains invalid signed URLs", () => {
    const resource = {
      _tag: "media-file" as const,
      threadId: ThreadId.make("thread"),
      path: "/tmp/missing.png",
    };
    expect(
      assetUrlStateFromResult(
        AsyncResult.failure(Cause.fail(new AssetWorkspaceAssetNotFoundError({ resource }))),
        "https://host.test",
      ),
    ).toEqual({
      _tag: "Failure",
      reason: "Media file was not found.",
    });
    expect(
      assetUrlStateFromResult(
        AsyncResult.success({ relativeUrl: "/api/assets/token/shot.png", expiresAt: 1000 }),
        "invalid origin",
      ),
    ).toEqual({
      _tag: "Failure",
      reason: "The environment returned an invalid asset URL.",
    });
  });
});

describe("createAssetEnvironmentAtoms", () => {
  it.effect.each([
    {
      name: "markdown image belongs to its remote environment",
      path: "/tmp/frame.png",
      mediaOnly: true,
    },
    { name: "missing video", path: "/tmp/clip.mp4", fallback: true },
    { name: "literal filename characters", path: "/tmp/frame#one?two.png", fallback: true },
    { name: "windows path", path: "C:\\Users\\demo\\clip.mp4", fallback: true },
    { name: "inspection failure", path: "/tmp/clip.mp4", error: "inspection", fallback: true },
    { name: "foreign thread", path: "/tmp/clip.mp4", error: "context", fallback: true },
    { name: "missing on both hosts", path: "/tmp/clip.mp4", localFails: true },
    {
      name: "a defect in the local retry",
      path: "/tmp/clip.mp4",
      localFails: true,
      localDefect: true,
    },
    { name: "remote success", path: "/tmp/clip.mp4", success: true },
    { name: "relative path", path: "clip.mp4" },
    { name: "no primary", path: "/tmp/clip.mp4", primary: "none" },
    { name: "primary reconnect", path: "/tmp/frame.png", primary: "reconnecting" },
    { name: "same environment", path: "/tmp/clip.mp4", primary: "same" },
    { name: "non-media", path: "/tmp/report.html" },
    { name: "authorization failure", path: "/tmp/clip.mp4", error: "auth" },
  ])("uses the correct environment for $name", (scenario) =>
    Effect.gen(function* () {
      const remoteId = EnvironmentId.make("remote");
      const localId = EnvironmentId.make("local");
      const resource = {
        _tag: "media-file" as const,
        threadId: ThreadId.make("foreign-thread"),
        path: scenario.path,
        ...("mediaOnly" in scenario ? { mediaOnly: scenario.mediaOnly } : {}),
      };
      const error =
        scenario.error === "auth"
          ? new EnvironmentAuthorizationError({
              message: "denied",
              requiredScope: "orchestration:read",
            })
          : scenario.error === "inspection"
            ? new AssetWorkspaceAssetInspectionError({ resource, cause: new Error("unreadable") })
            : scenario.error === "context"
              ? new AssetWorkspaceContextNotFoundError({ resource })
              : new AssetWorkspaceAssetNotFoundError({ resource, checkedPath: "/tmp/clip.mp4" });
      const calls: EnvironmentId[] = [];
      const supervisors = new Map<
        EnvironmentId,
        EnvironmentSupervisor.EnvironmentSupervisor["Service"]
      >();
      for (const environmentId of [remoteId, localId]) {
        const client = {
          [WS_METHODS.assetsCreateUrl]: () => {
            calls.push(environmentId);
            if (environmentId === localId && scenario.localFails) {
              const localError = Effect.fail(
                new AssetWorkspaceAssetNotFoundError({ resource, checkedPath: "/local/clip.mp4" }),
              );
              return scenario.localDefect
                ? localError.pipe(Effect.ensuring(Effect.die("cleanup failed")))
                : localError;
            }
            return environmentId === remoteId && !scenario.success
              ? Effect.fail(error)
              : Effect.succeed({
                  relativeUrl: `/api/assets/${environmentId}/media`,
                  expiresAt: 999999,
                });
          },
        } as unknown as WsRpcProtocolClient;
        const session = { client } as RpcSession;
        supervisors.set(
          environmentId,
          EnvironmentSupervisor.EnvironmentSupervisor.of({
            target: new PrimaryConnectionTarget({
              environmentId,
              label: environmentId,
              httpBaseUrl: `https://${environmentId}.test`,
              wsBaseUrl: `wss://${environmentId}.test`,
            }),
            state: yield* SubscriptionRef.make<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected" as const,
            }),
            session: yield* SubscriptionRef.make(Option.some(session)),
            prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          }),
        );
      }
      const environments = EnvironmentRegistry.EnvironmentRegistry.of({
        run: (id, effect) =>
          Effect.provideService(
            effect,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisors.get(id)!,
          ),
        followStream: (id, stream) =>
          Stream.provideService(
            stream,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisors.get(id)!,
          ),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const localTarget = {
        environmentId: scenario.primary === "same" ? remoteId : localId,
        httpBaseUrl: "https://local.test",
      };
      const localEnvironment = Atom.make<typeof localTarget | null>(
        scenario.primary === "none" || scenario.primary === "reconnecting" ? null : localTarget,
      );
      const assets = createAssetEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments)),
        localEnvironment,
      );
      const query = assets.createUrl({ environmentId: remoteId, input: { resource } });
      const result = AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
      if (scenario.fallback || scenario.success) {
        expect((yield* result).relativeUrl).toBe(
          scenario.fallback
            ? "https://local.test/api/assets/local/media"
            : "/api/assets/remote/media",
        );
      } else if (scenario.localDefect) {
        const cause = yield* Effect.sandbox(result).pipe(Effect.flip);
        expect(Cause.findErrorOption(cause)).toEqual(Option.some(error));
        expect(Cause.findDefect(cause)).toEqual(Result.succeed("cleanup failed"));
      } else {
        expect(yield* Effect.flip(result)).toEqual(error);
      }
      expect(calls).toEqual(
        scenario.fallback || scenario.localFails ? [remoteId, localId] : [remoteId],
      );
      if (scenario.primary === "reconnecting") {
        registry.set(localEnvironment, localTarget);
        expect((yield* result).relativeUrl).toBe("https://local.test/api/assets/local/media");
        expect(calls).toEqual([remoteId, remoteId, localId]);
      }
    }).pipe(Effect.scoped),
  );
});
