import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
} from "@t3tools/contracts";

import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";

import * as Ref from "effect/Ref";

import * as Scope from "effect/Scope";

import * as SynchronizedRef from "effect/SynchronizedRef";

import { expect, vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";

import * as TerminalManager from "./Manager.ts";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

vi.mock("effect/SynchronizedRef", async (importOriginal) => {
  const original = await importOriginal<typeof SynchronizedRef>();
  return { ...original, make: vi.fn(original.make) };
});

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly pid: number;
  writeFailure: unknown | undefined;
  resizeFailure: unknown | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  killed = false;
  exitOnSubscribe: PtyAdapter.PtyExitEvent | undefined;
  onKill: ((signal?: string) => void) | undefined;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string): void {
    if (this.writeFailure !== undefined) {
      throw this.writeFailure;
    }
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    if (this.resizeFailure !== undefined) {
      throw this.resizeFailure;
    }
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
    this.onKill?.(signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    if (this.exitOnSubscribe) callback(this.exitOnSubscribe);
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  get exitListenerCount(): number {
    return this.exitListeners.size;
  }

  emitExit(event: PtyAdapter.PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter {
  readonly spawnInputs: PtyAdapter.PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private readonly mode: "sync" | "async";
  private nextPid = 9000;
  exitOnSubscribe: PtyAdapter.PtyExitEvent | undefined;

  constructor(mode: "sync" | "async" = "sync") {
    this.mode = mode;
  }

  spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtyAdapter.PtySpawnError({
          adapter: "fake",
          shell: input.shell,
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    process.exitOnSubscribe = this.exitOnSubscribe;
    this.processes.push(process);
    if (this.mode === "async") {
      return Effect.tryPromise({
        try: async () => process,
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "fake",
            shell: input.shell,
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

interface CreateManagerOptions {
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: (terminalPid: number) => Effect.Effect<{
    readonly hasRunningSubprocess: boolean;
    readonly childCommand: string | null;
    readonly processIds: ReadonlyArray<number>;
  }>;
  processTable?: Effect.Effect<
    ReadonlyArray<{ readonly pid: number; readonly ppid: number; readonly name: string }>,
    never
  >;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  registerTerminalProcesses?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["registerTerminalProcesses"];
  maxRetainedInactiveSessions?: number;
  historyByteLimit?: number;
  ptyAdapter?: FakePtyAdapter;
  resolveProviderInstanceEnvironment?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["resolveProviderInstanceEnvironment"];
  managedBinaryCacheDir?: string;
  managedBinaryToolsDir?: string;
}

interface ManagerFixture {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly ptyAdapter: FakePtyAdapter;
  readonly manager: TerminalManager.TerminalManager["Service"];
  readonly getEvents: Effect.Effect<ReadonlyArray<TerminalEvent>>;
}

const createManager = (
  historyLineLimit = 5,
  options: CreateManagerOptions = {},
): Effect.Effect<
  ManagerFixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope | ProcessRunner.ProcessRunner
> =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-terminal-" });
      const logsDir = join(baseDir, "userdata", "logs", "terminals");
      const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();

      const manager = yield* TerminalManager.makeWithOptions({
        logsDir,
        historyLineLimit,
        ptyAdapter,
        ...(options.historyByteLimit !== undefined
          ? { historyByteLimit: options.historyByteLimit }
          : {}),
        ...(options.shellResolver !== undefined ? { shellResolver: options.shellResolver } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.subprocessInspector !== undefined
          ? { subprocessInspector: options.subprocessInspector }
          : {}),
        ...(options.processTable !== undefined ? { processTable: options.processTable } : {}),
        ...(options.subprocessPollIntervalMs !== undefined
          ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
          : {}),
        processKillGraceMs: options.processKillGraceMs ?? 1,
        ...(options.registerTerminalProcesses !== undefined
          ? { registerTerminalProcesses: options.registerTerminalProcesses }
          : {}),
        ...(options.maxRetainedInactiveSessions !== undefined
          ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
          : {}),
        ...(options.resolveProviderInstanceEnvironment !== undefined
          ? { resolveProviderInstanceEnvironment: options.resolveProviderInstanceEnvironment }
          : {}),
        ...(options.managedBinaryCacheDir === undefined
          ? {}
          : {
              managedBinaryCacheDir: options.managedBinaryCacheDir,
              managedBinaryToolsDir: options.managedBinaryToolsDir,
            }),
      });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(eventsRef, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      return {
        baseDir,
        logsDir,
        join,
        ptyAdapter,
        manager,
        getEvents: Ref.get(eventsRef),
      };
    }),
  );

it.effect(
  "launches inline shell commands directly and streams ordered output, input and exit",
  () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        subprocessInspector: () =>
          Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
      });
      const exited = yield* Deferred.make<void>();
      const received: TerminalEvent[] = [];
      const unsubscribe = yield* manager.subscribe((event) =>
        Effect.gen(function* () {
          received.push(event);
          if (event.type === "exited") yield* Deferred.succeed(exited, undefined);
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const metadata: TerminalMetadataStreamEvent[] = [];
      const unsubscribeMetadata = yield* manager.subscribeMetadata((event) =>
        Effect.sync(() => {
          metadata.push(event);
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeMetadata));
      yield* manager.openCommand({
        ...openInput(),
        terminalId: "inline-run",
        command: { command: "read answer; printf '%s' \"$answer\"; exit 7", language: "bash" },
      });
      expect(ptyAdapter.spawnInputs[0]).toMatchObject({
        shell: "bash",
        args: ["-c", "read answer; printf '%s' \"$answer\"; exit 7"],
      });
      expect(
        metadata.some(
          (event) =>
            event.type === "upsert" &&
            event.terminal.terminalId === "inline-run" &&
            event.terminal.inline === true,
        ),
      ).toBe(true);
      yield* manager.open({ ...openInput(), terminalId: "normal-drawer" });
      expect(
        metadata.some(
          (event) =>
            event.type === "upsert" &&
            event.terminal.terminalId === "normal-drawer" &&
            event.terminal.inline === undefined,
        ),
      ).toBe(true);
      const process = ptyAdapter.processes[0]!;
      yield* manager.closeIdle({ threadId: "thread-1" });
      expect(process.killed).toBe(false);
      yield* manager.write({ threadId: "thread-1", terminalId: "inline-run", data: "yes\r" });
      yield* manager.write({ threadId: "thread-1", terminalId: "inline-run", data: "\u0003" });
      expect(process.writes).toEqual(["yes\r", "\u0003"]);
      process.emitData("answer: yes\r\n");
      process.emitExit({ exitCode: 7, signal: null });
      yield* Deferred.await(exited);
      expect(
        received
          .filter((event) => event.type === "output" || event.type === "exited")
          .map((event) => event.type),
      ).toEqual(["output", "exited"]);
      expect(received.at(-1)).toMatchObject({ type: "exited", exitCode: 7 });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
);
