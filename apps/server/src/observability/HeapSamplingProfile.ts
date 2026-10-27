// @effect-diagnostics nodeBuiltinImport:off - the inspector and filesystem free space have no Effect equivalents.
import * as NodeFSP from "node:fs/promises";
import * as NodeInspector from "node:inspector";
import * as NodePath from "node:path";
import * as NodeV8 from "node:v8";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

let session: NodeInspector.Session | undefined;
let starting: Promise<void> | undefined;
let attempted = false;

export const start = Effect.tryPromise(() => {
  starting ??= new Promise<void>((resolve, reject) => {
    const inspector = new NodeInspector.Session();
    inspector.connect();
    // 512 KiB limits continuous profiling overhead while retaining allocation stacks.
    inspector.post("HeapProfiler.startSampling", { samplingInterval: 512 * 1024 }, (error) => {
      if (error) reject(error);
      else {
        session = inspector;
        resolve();
      }
    });
  });
  return starting;
}).pipe(
  Effect.catch((cause) => Effect.logWarning("Failed to start heap sampling profiler.", { cause })),
);

export const check = Effect.fn("server.heapPressureSamplingProfile")(function* (
  heapUsedBytes: number,
  logsDir: string,
) {
  if (attempted || session === undefined) return;
  const limit = NodeV8.getHeapStatistics().heap_size_limit;
  if (heapUsedBytes < limit * 0.6) return;
  attempted = true;
  const inspector = session;
  yield* Effect.gen(function* () {
    const disk = yield* Effect.tryPromise(() => NodeFSP.statfs(logsDir));
    // Reserve space for ordinary log writes as well as the profile.
    if (disk.bavail * disk.bsize < 1024 ** 3) {
      yield* Effect.logWarning("Skipping heap sampling profile: insufficient free disk space.");
      return;
    }
    const timestamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
    const path = NodePath.join(logsDir, `heap-${timestamp}.heapprofile`);
    yield* Effect.logWarning("Heap near limit; writing heap sampling profile.", {
      path,
      heapUsedBytes,
      limit,
    });
    const { profile } = yield* Effect.tryPromise(
      () =>
        new Promise<NodeInspector.HeapProfiler.GetSamplingProfileReturnType>((resolve, reject) => {
          inspector.post("HeapProfiler.getSamplingProfile", (error, result) => {
            if (error) reject(error);
            else resolve(result);
          });
        }),
    );
    const json = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(profile);
    yield* Effect.tryPromise(() => NodeFSP.writeFile(path, json)).pipe(
      Effect.tapError(() =>
        Effect.tryPromise(() => NodeFSP.rm(path, { force: true })).pipe(Effect.ignore),
      ),
    );
    yield* Effect.logInfo("Wrote heap pressure sampling profile.", { path });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Failed to write heap pressure sampling profile.", { cause }),
    ),
  );
});
