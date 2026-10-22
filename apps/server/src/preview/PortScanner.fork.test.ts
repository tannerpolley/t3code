import { it as effectIt } from "@effect/vitest";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as TestClock from "effect/testing/TestClock";

import { expect } from "vite-plus/test";
import { FetchHttpClient } from "effect/http";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import {
  LSOF_TEST_PORT,
  makeProjectStore,
  processProbeFailure,
} from "./PortScanner.testHarness.ts";
import * as PortScanner from "./PortScanner.ts";

/** The fork's discovery attribution reads projects and hide rules; these tests use none. */
const layerNoAttribution = Layer.mergeAll(makeProjectStore(), ServerSettingsModule.layerTest());

const layerNoProc = FileSystem.layerNoop({});

const layerProbeFailure = (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  fetch: typeof globalThis.fetch = globalThis.fetch,
  fileSystem: Layer.Layer<FileSystem.FileSystem> = layerNoProc,
) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Path.layer,
        fileSystem,
        layerNoAttribution,
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(HostProcess.Platform, "linux"),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    ),
  );

const ownedScanner = (processIds: ReadonlyArray<number> = [1234]) =>
  Effect.tap(PortScanner.PortDiscovery, (scanner) =>
    scanner.registerTerminalProcesses({
      threadId: "scanner-thread",
      terminalId: "scanner-terminal",
      processIds,
    }),
  );

const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5001 1 0000000000000000 100 0 0 10 0
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5002 1 0000000000000000 100 0 0 10 0
   2: 0100007F:223D 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 5003 1 0000000000000000 20 4 30 10 -1
   3: 0A00000F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5005 1 0000000000000000 100 0 0 10 0
`;
const PROC_NET_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0BB9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5004 1 0000000000000000 100 0 0 10 0
`;

effectIt.effect(
  "reads Linux listeners from /proc when lsof is missing, and stops spawning it",
  () => {
    let lsofSpawns = 0;
    const fdWalks: string[] = [];
    const procFiles: Record<string, string> = {
      "/proc/net/tcp": PROC_NET_TCP,
      "/proc/net/tcp6": PROC_NET_TCP6,
      "/proc/4242/comm": "python3\n",
    };
    const procFds: Record<string, Record<string, string>> = {
      "4242": { "0": "/dev/null", "3": "socket:[5001]" },
      "77": { "5": "socket:[9999]" },
    };
    const missing = FileSystem.makeNoop({});
    const fileSystem = FileSystem.layerNoop({
      readFileString: (path) => {
        const content = procFiles[path];
        return content === undefined ? missing.readFileString(path) : Effect.succeed(content);
      },
      readDirectory: (path) => {
        if (path === "/proc") return Effect.succeed(["self", "77", "4242"]);
        const pid = /^\/proc\/(\d+)\/fd$/.exec(path)?.[1];
        const fds = pid === undefined ? undefined : procFds[pid];
        if (pid === undefined || fds === undefined) return missing.readDirectory(path);
        fdWalks.push(pid);
        return Effect.succeed(Object.keys(fds));
      },
      readLink: (path) => {
        const [, pid, fd] = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path) ?? [];
        const target = pid && fd ? procFds[pid]?.[fd] : undefined;
        return target === undefined ? missing.readLink(path) : Effect.succeed(target);
      },
    });
    const fetchFn = (() =>
      Promise.resolve(
        new Response("hello", { headers: { "content-type": "text/html" } }),
      )) as typeof globalThis.fetch;
    const layer = layerProbeFailure(
      (input) => {
        lsofSpawns += 1;
        return processProbeFailure(input);
      },
      fetchFn,
      fileSystem,
    );

    return Effect.gen(function* () {
      const scanner = yield* ownedScanner([4242]);
      const first = yield* scanner.scan();
      // Port 22 has no known owner, so it never receives probes; 3001 is a common dev port.
      expect(first.map(({ port, pid, processName }) => ({ port, pid, processName }))).toEqual([
        { port: 3001, pid: null, processName: null },
        { port: 8765, pid: 4242, processName: "python3" },
      ]);
      yield* scanner.scan();
      expect(lsofSpawns).toBe(1);
      expect(fdWalks).toEqual(["77", "4242", "77", "4242"]);
      yield* scanner.scan();
      yield* scanner.scan();
      expect(fdWalks).toEqual(["77", "4242", "77", "4242", "77", "4242"]);
    }).pipe(Effect.provide(layer));
  },
);

effectIt.effect.each(["linux", "darwin"] as const)(
  "skips idle listener scans on %s and resumes when candidates exist",
  (platform) => {
    let listenerScans = 0;
    const layer = PortScanner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerNoProc,
          Path.layer,
          layerNoAttribution,
          Layer.succeed(HostProcess.Platform, platform),
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: (input) => {
              if (input.command === "lsof") listenerScans += 1;
              return Effect.succeed({
                stdout: `p1234\ncnode\nn*:${LSOF_TEST_PORT}\n`,
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              });
            },
          }),
          FetchHttpClient.layer.pipe(
            Layer.provide(
              Layer.succeed(FetchHttpClient.Fetch, () =>
                Promise.resolve(
                  new Response("hello", { headers: { "content-type": "text/html" } }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.retain;
      yield* TestClock.adjust("9 seconds");
      expect(yield* scanner.scan()).toEqual([]);
      expect(listenerScans).toBe(0);

      yield* scanner.registerTerminalProcesses({
        threadId: "scanner-thread",
        terminalId: "scanner-terminal",
        processIds: [1234],
      });
      expect(yield* scanner.scan()).toMatchObject([{ port: LSOF_TEST_PORT, pid: 1234 }]);
      expect(listenerScans).toBe(1);

      yield* scanner.unregisterTerminal({
        threadId: "scanner-thread",
        terminalId: "scanner-terminal",
      });
      yield* TestClock.adjust("9 seconds");
      expect(yield* scanner.scan()).toEqual([]);
      expect(listenerScans).toBe(1);

      expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/docs`])).toMatchObject([
        { port: LSOF_TEST_PORT, url: `http://localhost:${LSOF_TEST_PORT}/docs` },
      ]);
      expect(listenerScans).toBe(2);
    }).pipe(Effect.provide(layer));
  },
);
