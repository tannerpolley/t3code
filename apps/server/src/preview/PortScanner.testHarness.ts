import { type OrchestrationProjectShell } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { FetchHttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as PortScanner from "./PortScanner.ts";

type ProjectRoots = ReadonlyArray<Pick<OrchestrationProjectShell, "id" | "workspaceRoot">>;

const makeProjectStore = (projects: ProjectRoots = []) =>
  Layer.succeed(
    ProjectStore.ProjectStoreV2,
    ProjectStore.ProjectStoreV2.of({
      listShells: () => Effect.succeed(projects),
    } as never),
  );

const processProbeFailure: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
  Effect.fail(
    new ProcessRunner.ProcessSpawnError({
      command: input.command,
      argumentCount: input.args.length,
      cwd: input.cwd,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "PowerShell is not installed in the test environment",
      }),
    }),
  );

const LSOF_TEST_PORT = 43_123;

const makeLsofScannerWithoutSettings = (input: {
  readonly pid: () => number;
  readonly fetch: typeof globalThis.fetch;
  readonly platform?: NodeJS.Platform;
  readonly listeners?: ReadonlyArray<{
    readonly pid: number;
    readonly port: number;
    readonly name?: string;
  }>;
  readonly parents?: () => ReadonlyMap<number, number>;
  readonly parentFailure?: boolean;
  readonly cgroups?: ReadonlyMap<number, string>;
  readonly cwds?: ReadonlyMap<number, string>;
  readonly projects?: ProjectRoots;
  readonly realPaths?: ReadonlyMap<string, string>;
  /** `.git` files by path, as in a linked git worktree. */
  readonly gitFiles?: ReadonlyMap<string, string>;
}) => {
  const parents = input.parents ?? (() => new Map([[input.pid(), process.pid]]));
  const platform = input.platform ?? "linux";
  return PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Path.layer,
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: Effect.fn("ProcessRunner.ProcessRunner.run")((command) => {
            const parentProbe =
              command.command === "ps" || command.args.at(-1)?.includes("Get-CimInstance");
            if (parentProbe && input.parentFailure) return processProbeFailure(command);
            const listeners = input.listeners ?? [{ pid: input.pid(), port: LSOF_TEST_PORT }];
            return Effect.succeed({
              stdout: parentProbe
                ? [...parents()].map(([pid, ppid]) => `${pid} ${ppid}`).join("\n")
                : listeners
                    .map(({ pid, port, name = "node" }) =>
                      platform === "win32"
                        ? `127.0.0.1|${port}|${pid}|${name}`
                        : `p${pid}\nc${name}\nn*:${port}\n`,
                    )
                    .join("\n"),
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            });
          }),
        }),
        makeProjectStore(input.projects),
        Layer.succeed(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            realPath: (path) => Effect.succeed(input.realPaths?.get(path) ?? path),
            exists: (path) => Effect.succeed(input.gitFiles?.has(path) ?? false),
            readLink: (path) => {
              const cwd = input.cwds?.get(Number(path.split("/")[2]));
              return cwd === undefined
                ? FileSystem.makeNoop({}).readLink(path)
                : Effect.succeed(cwd);
            },
            ...(input.parentFailure
              ? {}
              : {
                  readDirectory: () => Effect.sync(() => [...parents().keys()].map(String)),
                  readFileString: (path: string) =>
                    Effect.sync(() => {
                      const gitFile = input.gitFiles?.get(path);
                      if (gitFile !== undefined) return gitFile;
                      const pid = Number(path.split("/")[2]);
                      if (path.endsWith("/cgroup")) return input.cgroups?.get(pid) ?? "0::/";
                      return `${pid} (node worker) name) S ${parents().get(pid)} 0 0`;
                    }),
                }),
          }),
        ),
        Layer.succeed(HostProcess.Platform, platform),
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, input.fetch)),
        ),
      ),
    ),
  );
};

const makeLsofScannerLayer = (input: Parameters<typeof makeLsofScannerWithoutSettings>[0]) =>
  makeLsofScannerWithoutSettings(input).pipe(Layer.provide(ServerSettingsModule.layerTest()));
export {
  LSOF_TEST_PORT,
  makeLsofScannerLayer,
  makeLsofScannerWithoutSettings,
  makeProjectStore,
  processProbeFailure,
};
