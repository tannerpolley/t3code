import {
  makeTraceSink,
  type TraceRecord,
  type TraceSinkOptions,
} from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";

const launchSpans = new Set([
  "ThreadLaunchService.launch",
  "ThreadLaunchService.prepareRun",
  "ProviderTurnStartService.start",
  "orchestrationV2.providerTurnStart.start",
]);

function keepLocalRecord(record: TraceRecord): boolean {
  const lockWaitMs = record.attributes["db.lock_wait_ms"];
  return (
    record.durationMs >= 1_000 ||
    (typeof lockWaitMs === "number" && lockWaitMs >= 100) ||
    record.events.length > 0 ||
    launchSpans.has(record.name) ||
    (record.type === "effect-span"
      ? record.exit._tag === "Failure"
      : record.status?.code === "2") ||
    (typeof record.traceId === "string" &&
      Number.parseInt(record.traceId.slice(-8), 16) % 100 === 0)
  );
}

// Keep the sampling decision local to disk and consistent across spans that share a trace ID.
export const makeServerTraceSink = (options: TraceSinkOptions) =>
  makeTraceSink(options).pipe(
    Effect.map((sink) => ({
      ...sink,
      push(record: TraceRecord) {
        if (keepLocalRecord(record)) sink.push(record);
      },
    })),
  );
