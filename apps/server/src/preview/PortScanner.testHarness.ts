import { type OrchestrationProjectShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";

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

export { LSOF_TEST_PORT, makeProjectStore, processProbeFailure };
