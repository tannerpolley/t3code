import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

// Only fork-dev/seed.sh opts into these synthetic descendants; normal telemetry is untouched.
const decodeDevProcessFixture = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        pid: Schema.Int.check(Schema.isGreaterThan(0)),
        ppid: Schema.Union([
          Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          Schema.Literal("server"),
        ]),
        command: Schema.String,
        cpuPercent: Schema.Number,
        residentBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        startTimeMs: Schema.Number,
      }),
    ),
  ),
);

export const readDevProcessFixture = Effect.fn("orchestration.readDevProcessFixture")(function* (
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path).pipe(
    Effect.flatMap(decodeDevProcessFixture),
    Effect.map((processes) =>
      processes.map(({ pid, ppid, startTimeMs, ...sample }) => ({
        ...sample,
        identity: { pid, startTimeMs },
        ppid: ppid === "server" ? process.pid : ppid,
      })),
    ),
    Effect.orElseSucceed(() => null),
  );
});
