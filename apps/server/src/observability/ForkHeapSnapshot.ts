// @effect-diagnostics nodeBuiltinImport:off - V8 snapshots and filesystem free space have no Effect equivalents.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeV8 from "node:v8";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

// A failed snapshot attempt must not repeatedly stall a process under pressure.
let attempted = false;

export const check = Effect.fn("server.heapPressureSnapshot")(function* (
  heapUsedBytes: number,
  logsDir: string,
) {
  if (attempted) return;
  const limit = NodeV8.getHeapStatistics().heap_size_limit;
  if (heapUsedBytes < limit * 0.6) return;
  attempted = true;
  yield* Effect.gen(function* () {
    const availableMemoryBytes =
      (yield* HostProcess.Platform) === "linux"
        ? yield* Effect.tryPromise(async () => {
            const meminfo = await NodeFSP.readFile("/proc/meminfo", "utf8");
            const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
            if (available === null) throw new Error("MemAvailable missing from /proc/meminfo");
            return Number(available[1]) * 1024;
          })
        : NodeOS.freemem();
    if (availableMemoryBytes < heapUsedBytes * 1.5) {
      attempted = false;
      yield* Effect.logWarning("Skipping heap snapshot: insufficient available system memory.", {
        availableMemoryBytes,
        heapUsedBytes,
      });
      return;
    }
    const disk = yield* Effect.tryPromise(() => NodeFSP.statfs(logsDir));
    // Leave room for a snapshot larger than the heap, plus ordinary log writes.
    if (disk.bavail * disk.bsize < limit * 2 + 1024 ** 3) {
      yield* Effect.logWarning("Skipping heap snapshot: insufficient free disk space.");
      return;
    }
    const timestamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
    const path = NodePath.join(logsDir, `heap-${timestamp}.heapsnapshot`);
    yield* Effect.logWarning("Heap near limit; writing heap snapshot.", {
      path,
      heapUsedBytes,
      limit,
    });
    yield* Effect.try(() => NodeV8.writeHeapSnapshot(path)).pipe(
      Effect.tapError(() =>
        Effect.tryPromise(() => NodeFSP.rm(path, { force: true })).pipe(Effect.ignore),
      ),
    );
    yield* Effect.logInfo("Wrote heap pressure snapshot.", { path });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Failed to write heap pressure snapshot.", { cause }),
    ),
  );
});
