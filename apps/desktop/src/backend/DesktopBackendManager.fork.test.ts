import { DesktopBackendBootstrap } from "@t3tools/contracts";
import type { DesktopBackendBootstrap as DesktopBackendBootstrapValue } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess } from "effect/process";

import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as Sink from "effect/Sink";

import * as Stream from "effect/Stream";

import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

const decodeDesktopBackendBootstrap = Schema.decodeEffect(
  Schema.fromJsonString(DesktopBackendBootstrap),
);

const baseConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "/electron",
  args: ["/server/bin.mjs", "--bootstrap-fd", "3"],
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: { ELECTRON_RUN_AS_NODE: "1" },
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    desktopTelemetryFd: 4,
    desktopTelemetryControlFd: 5,
  },
  bootstrapDelivery: "fd3",
  extendEnv: true,
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
  preflightFailure: Option.none(),
};

const configWithObservability: DesktopBackendBootstrapValue = {
  ...baseConfig.bootstrap,
  tailscaleServeEnabled: true,
  desktopTelemetryFd: 4,
  otlpTracesUrl: "http://127.0.0.1:4318/v1/traces",
};

function makeProcess(options?: {
  readonly stdout?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly stderr?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
  readonly kill?: ChildProcessSpawner.ChildProcessHandle["kill"];
  readonly getOutputFd?: ChildProcessSpawner.ChildProcessHandle["getOutputFd"];
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: options?.stdout ?? Stream.empty,
    stderr: options?.stderr ?? Stream.empty,
    all: Stream.merge(options?.stdout ?? Stream.empty, options?.stderr ?? Stream.empty),
    exitCode: options?.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: options?.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: options?.getOutputFd ?? (() => Stream.empty),
    unref: Effect.succeed(Effect.void),
  });
}

function responseForRequest(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(request, new Response(null, { status }));
}

function layerHttpClient(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

const layerHealthyHttpClient = layerHttpClient((request) =>
  Effect.succeed(responseForRequest(request, 200)),
);

function decodeBootstrap(raw: string) {
  return decodeDesktopBackendBootstrap(raw);
}

interface MakeInstanceInput {
  readonly spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly backendOutputLog?: Partial<DesktopObservability.DesktopBackendOutputLogShape>;
  readonly onReady?: Effect.Effect<void>;
  readonly onShutdown?: Effect.Effect<void>;
  readonly onStateDirOwned?: Effect.Effect<void>;
  readonly onPreflightFailed?: (
    failure: DesktopBackendManager.PreflightFailure,
  ) => Effect.Effect<boolean>;
  readonly config?: DesktopBackendManager.DesktopBackendStartConfig;
  readonly configResolve?: Effect.Effect<
    DesktopBackendManager.DesktopBackendStartConfig,
    PlatformError.PlatformError
  >;
  readonly desktopTelemetryStream?: Stream.Stream<Uint8Array>;
  readonly desktopTelemetryPublisher?: Partial<
    DesktopTelemetryPublisher.DesktopTelemetryPublisher["Service"]
  >;
  readonly pruneRuntimes?: (distro: string | null, runtimeId: string) => Effect.Effect<void>;
}

function makeTestInstance(input: MakeInstanceInput) {
  const stubLog: DesktopObservability.DesktopBackendOutputLogShape = {
    beginSession: () => Effect.void,
    writeOutputChunk: () => Effect.void,
    persistFailureSnapshot: () => Effect.void,
    persistFailure: () => Effect.void,
    discardSession: Effect.void,
    ...input.backendOutputLog,
  };
  const layerServices = Layer.mergeAll(
    FileSystem.layerNoop({
      exists: () => Effect.succeed(true),
    }),
    input.spawnerLayer,
    input.httpClientLayer ?? layerHealthyHttpClient,
    Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
      forInstance: () => Effect.succeed(stubLog),
    } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"]),
    Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
      latest: Effect.succeedNone,
      changes: Stream.empty,
      encoded: input.desktopTelemetryStream ?? Stream.empty,
      handleControlForSource: () => Effect.void,
      removeControlSource: () => Effect.void,
      publishUpdateReport: () => Effect.void,
      updateRequests: Stream.empty,
      updateCommits: Stream.empty,
      updateCancellations: Stream.empty,
      ...input.desktopTelemetryPublisher,
    }),
    DesktopBrowserHost.layer,
    DesktopWslEnvironment.layerTest(
      input.pruneRuntimes === undefined ? {} : { pruneRuntimes: input.pruneRuntimes },
    ),
  );

  const instance = DesktopBackendManager.makeBackendInstance({
    id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Windows"),
    configResolve: input.configResolve ?? Effect.succeed(input.config ?? baseConfig),
    ...(input.onReady ? { onReady: () => input.onReady! } : {}),
    ...(input.onShutdown ? { onShutdown: () => input.onShutdown! } : {}),
    ...(input.onStateDirOwned ? { onStateDirOwned: () => input.onStateDirOwned! } : {}),
    ...(input.onPreflightFailed ? { onPreflightFailed: input.onPreflightFailed } : {}),
  });

  return instance.pipe(Effect.provide(layerServices));
}

describe("DesktopBackendManager", () => {
  it.effect("spawns the backend with fd3 bootstrap and fd4 telemetry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let spawnedCommand: ChildProcess.Command | undefined;
        let bootstrapJson = "";
        let telemetryJson = "";
        let readyCount = 0;
        const ready = yield* Deferred.make<void>();
        const exited = yield* Queue.unbounded<void>();

        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              spawnedCommand = command;
              if (command._tag === "StandardCommand") {
                const fd3 = command.options.additionalFds?.fd3;
                if (fd3?.type === "input" && fd3.stream) {
                  bootstrapJson = yield* fd3.stream.pipe(Stream.decodeText(), Stream.mkString);
                }
                const fd4 = command.options.additionalFds?.fd4;
                if (fd4?.type === "input" && fd4.stream) {
                  telemetryJson = yield* fd4.stream.pipe(Stream.decodeText(), Stream.mkString);
                }
              }

              return makeProcess({
                exitCode: Deferred.await(ready).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          config: {
            ...baseConfig,
            bootstrap: configWithObservability,
          },
          spawnerLayer: layerSpawner,
          desktopTelemetryStream: Stream.encodeText(
            Stream.make('{"version":1,"type":"desktopTelemetryHello","electronPid":123}\n'),
          ),
          onReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0)), Effect.asVoid),
          backendOutputLog: {
            persistFailure: () => Queue.offer(exited, void 0).pipe(Effect.asVoid),
          },
        });

        yield* instance.start;
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.isDefined(spawnedCommand);
        if (spawnedCommand._tag !== "StandardCommand") {
          throw new Error("Expected backend to spawn a standard command.");
        }

        assert.equal(spawnedCommand.command, "/electron");
        assert.deepEqual(spawnedCommand.args, ["/server/bin.mjs", "--bootstrap-fd", "3"]);
        assert.equal(spawnedCommand.options.cwd, "/server");
        assert.equal(spawnedCommand.options.extendEnv, true);
        assert.equal(spawnedCommand.options.stdout, "pipe");
        assert.equal(spawnedCommand.options.stderr, "pipe");
        assert.equal(spawnedCommand.options.killSignal, "SIGTERM");
        assert.isDefined(spawnedCommand.options.forceKillAfter);
        assert.equal(spawnedCommand.options.additionalFds?.fd4?.type, "input");
        assert.equal(spawnedCommand.options.additionalFds?.fd5?.type, "output");
        assert.equal(
          Duration.toMillis(Duration.fromInputUnsafe(spawnedCommand.options.forceKillAfter)),
          10_000,
        );

        assert.deepEqual(yield* decodeBootstrap(bootstrapJson), configWithObservability);
        assert.equal(
          telemetryJson,
          '{"version":1,"type":"desktopTelemetryHello","electronPid":123}\n',
        );
      }),
    ),
  );

  it.effect("recognizes migration status across output chunks and keeps streams separate", () =>
    Effect.gen(function* () {
      const statuses: boolean[] = [];
      const layerSpawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeProcess({
              stdout: Stream.encodeText(
                Stream.make(
                  "unrelated log\nRunning database ",
                  "migrations\nMigrations ran success",
                  "fully\nRunning database migrations\nDatabase shrinking migration skipped\nRunning database ",
                ),
              ),
              stderr: Stream.encodeText(Stream.make("migrations\n")),
            }),
          ),
        ),
      );
      yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
        onMigrationStatus: (running) =>
          Effect.sync(() => {
            statuses.push(running);
          }),
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSpawner, layerHealthyHttpClient)));
      assert.deepEqual(statuses, [true, false, true, false]);
    }),
  );

  it.effect("does not report a readiness timeout while migrations run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const migrationsDone = yield* Deferred.make<void>();
        const statuses = yield* Queue.unbounded<boolean>();
        const failures = yield* Queue.unbounded<void>();
        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                stdout: Stream.encodeText(
                  Stream.concat(
                    Stream.make("Running database migrations\n"),
                    Stream.fromEffect(
                      Deferred.await(migrationsDone).pipe(
                        Effect.as("Migrations ran successfully\n"),
                      ),
                    ),
                  ).pipe(Stream.concat(Stream.never)),
                ),
                exitCode: Effect.never,
              }),
            ),
          ),
        );
        yield* DesktopBackendManager.runBackendProcess({
          ...baseConfig,
          desktopTelemetryStream: Stream.empty,
          readinessTimeout: Duration.seconds(1),
          onMigrationStatus: (running) => Queue.offer(statuses, running).pipe(Effect.asVoid),
          onReadinessFailure: () => Queue.offer(failures, void 0).pipe(Effect.asVoid),
        }).pipe(
          Effect.provide(
            Layer.merge(
              layerSpawner,
              layerHttpClient((request) => Effect.succeed(responseForRequest(request, 503))),
            ),
          ),
          Effect.forkScoped,
        );

        assert.isTrue(yield* Queue.take(statuses));
        yield* TestClock.adjust(Duration.seconds(5));
        assert.equal(yield* Queue.size(failures), 0);

        yield* Deferred.succeed(migrationsDone, void 0);
        assert.isFalse(yield* Queue.take(statuses));
        yield* TestClock.adjust(Duration.seconds(2));
        yield* Queue.take(failures);
      }),
    ),
  );

  it.effect("notifies shutdown when the backend exits before readiness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stopped = yield* Deferred.make<void>();
        const instance = yield* makeTestInstance({
          spawnerLayer: Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.succeed(makeProcess())),
          ),
          httpClientLayer: layerHttpClient(() => Effect.never),
          onShutdown: Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
        });
        yield* instance.start;
        yield* Deferred.await(stopped);
        assert.isFalse((yield* instance.snapshot).ready);
      }),
    ),
  );

  it.effect("bounds backend teardown after the quit grace when backends hang", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const teardownStarted = yield* Queue.unbounded<string>();
        const teardownFinished = yield* Queue.unbounded<string>();
        const allowTeardown = yield* Deferred.make<void>();

        const makeInstance = (name: string) =>
          makeTestInstance({
            spawnerLayer: Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.gen(function* () {
                  const scope = yield* Scope.Scope;
                  yield* Scope.addFinalizer(
                    scope,
                    Queue.offer(teardownStarted, name).pipe(
                      Effect.andThen(Deferred.await(allowTeardown)),
                      Effect.andThen(Queue.offer(teardownFinished, name)),
                      Effect.asVoid,
                    ),
                  );
                  return makeProcess({ exitCode: Effect.never });
                }),
              ),
            ),
            httpClientLayer: layerHttpClient(() => Effect.never),
          });

        const instance1 = yield* makeInstance("instance1");
        const instance2 = yield* makeInstance("instance2");

        yield* instance1.start;
        yield* instance2.start;

        const quitFiber = yield* Effect.forEach(
          [instance1, instance2],
          (instance) => instance.stop({ timeout: DesktopBackendManager.QUIT_BACKEND_STOP_TIMEOUT }),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);

        const started = yield* Queue.takeN(teardownStarted, 2);
        assert.deepEqual(started.toSorted(), ["instance1", "instance2"]);

        // Quit must outlast the 10 s kill grace before giving up on a hung backend.
        yield* TestClock.adjust(Duration.millis(10_500));
        assert.isUndefined(quitFiber.pollUnsafe());
        yield* TestClock.adjust(Duration.millis(1_500));
        yield* Fiber.join(quitFiber);
        assert.equal(yield* Queue.size(teardownFinished), 0);

        yield* Deferred.succeed(allowTeardown, undefined);
        const finished = yield* Queue.takeN(teardownFinished, 2);
        assert.deepEqual(finished.toSorted(), ["instance1", "instance2"]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
});
