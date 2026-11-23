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
  const heapGrowthBytes = record.attributes["memory.heap_growth_bytes"];
  return (
    record.durationMs >= 1_000 ||
    (typeof lockWaitMs === "number" && lockWaitMs >= 100) ||
    record.events.length > 0 ||
    launchSpans.has(record.name) ||
    record.name === "server.heap.spike" ||
    (typeof heapGrowthBytes === "number" && heapGrowthBytes >= 64 * 1_024 * 1_024) ||
    (record.type === "effect-span"
      ? record.exit._tag === "Failure"
      : record.status?.code === "2") ||
    (typeof record.spanId === "string" && Number.parseInt(record.spanId.slice(-8), 16) % 100 === 0)
  );
}

// The worker and commit loops can share a trace ID for the lifetime of the server.
export const makeServerTraceSink = (options: TraceSinkOptions) =>
  makeTraceSink(options).pipe(
    Effect.map((sink) => ({
      ...sink,
      push(record: TraceRecord) {
        if (keepLocalRecord(record)) sink.push(record);
      },
    })),
  );
