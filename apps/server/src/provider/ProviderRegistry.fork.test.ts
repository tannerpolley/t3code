import { vi } from "vite-plus/test";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";

import * as Schema from "effect/Schema";

import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { EnvironmentId, ClaudeSettings } from "@t3tools/contracts";

import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";

import * as ModelManifest from "./ModelManifest.ts";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";

import * as ServerSettingsModule from "../serverSettings.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const defaultClaudeSettings: ClaudeSettings = Schema.decodeSync(ClaudeSettings)({});

process.env.T3CODE_CURSOR_ENABLED = "1";

const encoder = new TextEncoder();

const layerTestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
).pipe(Layer.provideMerge(ModelManifest.layerTest));

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function layerMockSpawner(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
}

const layerTestNodeServices = Layer.mergeAll(
  ProviderLatestVersions.layer,
  NodeServices.layer,
  Layer.mock(CodexInstallation.CodexInstallation)({
    managedDirectory: "unused-managed-installation",
  }),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
  }),
);

it.layer(
  Layer.mergeAll(layerTestNodeServices, ServerSettingsModule.layerTest(), layerTestHttpClient),
)("ProviderRegistry", (it) => {
  describe("checkClaudeProviderStatus", () => {
    it.effect("keeps the original usage timestamp when capabilities are cached", () =>
      Effect.gen(function* () {
        const usageCheckedAt = "1970-01-01T00:00:00.000Z";
        const cachedCapabilities = () =>
          Effect.succeed({
            email: undefined,
            subscriptionType: "max",
            tokenSource: "oauth",
            apiKeySource: undefined,
            apiProvider: undefined,
            slashCommands: [],
            usageCheckedAt,
            usage: {
              rate_limits_available: true,
              rate_limits: { five_hour: { utilization: 84, resets_at: null } },
            },
          });
        const first = yield* checkClaudeProviderStatus(defaultClaudeSettings, cachedCapabilities);
        yield* TestClock.adjust("1 minute");
        const refreshed = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          cachedCapabilities,
        );

        assert.notStrictEqual(refreshed.checkedAt, first.checkedAt);
        assert.strictEqual(first.usageLimits?.checkedAt, usageCheckedAt);
        assert.strictEqual(refreshed.usageLimits?.checkedAt, usageCheckedAt);
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            if (args.join(" ") === "--version") {
              return { stdout: "2.1.288\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${args.join(" ")}`);
          }),
        ),
      ),
    );
  });
});
