import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OtlpTraceRecord } from "@t3tools/shared/observability";
import { decodeOtlpTraceRecords, makeLocalFileTracer } from "@t3tools/shared/observability";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { cast } from "effect/Function";
import * as Path from "effect/Path";
import * as Tracer from "effect/Tracer";
import type { OtlpTracer } from "effect/observability";

import * as BrowserTraceCollector from "./BrowserTraceCollector.ts";
import { makeServerTraceSink } from "./ServerTrace.ts";

const workerTraceId = "00000000000000000000000000000001";
const commitTraceId = "00000000000000000000000000000064";
const spanId = (n: number) => n.toString(16).padStart(16, "0");
const fastSpan = {
  sampled: true,
  kind: "internal",
  startTimeUnixNano: "1",
  endTimeUnixNano: "1000001",
  durationMs: 1,
  attributes: {},
  events: [],
  links: [],
};

it.effect("samples worker and commit spans independently of their boot-wide trace IDs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const sink = yield* makeServerTraceSink({
      filePath: path.join(dir, "server.trace.ndjson"),
      maxBytes: 1_024 * 1_024,
      maxFiles: 1,
      batchWindowMs: 1_000,
    });
    for (let n = 1; n <= 100; n++) {
      sink.push({
        ...fastSpan,
        type: "effect-span",
        exit: { _tag: "Success" },
        name: "OrchestrationEffectWorkerV2.runOnceInLane",
        traceId: workerTraceId,
        spanId: spanId(n),
      });
      sink.push({
        ...fastSpan,
        type: "effect-span",
        exit: { _tag: "Success" },
        name: "orchestrationV2.ProviderCommitBatch.flush",
        traceId: commitTraceId,
        spanId: spanId(n + 100),
      });
    }
    yield* sink.flush;
    const written = yield* fs.readFileString(sink.filePath);
    const records = written
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => [record.name, record.spanId])).toEqual([
      ["OrchestrationEffectWorkerV2.runOnceInLane", spanId(100)],
      ["orchestrationV2.ProviderCommitBatch.flush", spanId(200)],
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("samples the local server and renderer traces while forwarding every server span", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const options = {
      filePath: path.join(dir, "server.trace.ndjson"),
      maxBytes: 10 * 1024,
      maxFiles: 1,
      batchWindowMs: 1_000,
    };
    const sink = yield* makeServerTraceSink(options);
    const forwarded: Tracer.Span[] = [];
    const tracer = yield* makeLocalFileTracer({
      ...options,
      sink,
      delegate: Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          Object.defineProperty(span, "spanId", { value: spanId(forwarded.length + 1) });
          forwarded.push(span);
          return span;
        },
      }),
    });
    const effect = Effect.gen(function* () {
      yield* Effect.void.pipe(Effect.withSpan("sqlite"));
      yield* Effect.void.pipe(Effect.withSpan("ProviderTurnStartService.start"));
      yield* Effect.annotateCurrentSpan("db.lock_wait_ms", 150).pipe(
        Effect.withSpan("contended query"),
      );
      yield* Effect.fail("failed").pipe(Effect.withSpan("failed query"), Effect.ignore);
      yield* Effect.void.pipe(Effect.withSpan("server.heap.spike", { root: true }));
      yield* Effect.annotateCurrentSpan("memory.heap_growth_bytes", 200 * 1_024 * 1_024).pipe(
        Effect.withSpan("heap growth"),
      );
    }).pipe(
      Effect.withParentSpan(Tracer.externalSpan({ traceId: workerTraceId, spanId: "1" })),
      Effect.withTracer(tracer),
    );
    yield* effect;

    const rendererRecord: OtlpTraceRecord = {
      ...fastSpan,
      type: "otlp-span",
      traceId: workerTraceId,
      spanId: spanId(2),
      name: "EnvironmentRpc.currentSession",
      resourceAttributes: {},
      scope: { attributes: {} },
    };
    yield* BrowserTraceCollector.make(sink).record([
      rendererRecord,
      ...decodeOtlpTraceRecords(
        cast<unknown, OtlpTracer.TraceData>({
          resourceSpans: [{ scopeSpans: [{ spans: [{ name: "missing span ID" }] }] }],
        }),
      ),
      { ...rendererRecord, spanId: spanId(3), name: "slow request", durationMs: 1_000 },
      { ...rendererRecord, spanId: spanId(4), name: "failed request", status: { code: "2" } },
      { ...rendererRecord, spanId: spanId(100), name: "sampled request" },
      {
        ...rendererRecord,
        spanId: spanId(5),
        name: "request with event",
        events: [{ name: "logged", timeUnixNano: "1", attributes: {} }],
      },
    ]);
    yield* sink.flush;
    const written = yield* fs.readFileString(options.filePath);
    const names = written
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).name);

    expect(forwarded.map((span) => span.name)).toEqual([
      "sqlite",
      "ProviderTurnStartService.start",
      "contended query",
      "failed query",
      "server.heap.spike",
      "heap growth",
    ]);
    expect(forwarded.every((span) => span.status._tag === "Ended")).toBe(true);
    expect(names).toEqual([
      "ProviderTurnStartService.start",
      "contended query",
      "failed query",
      "server.heap.spike",
      "heap growth",
      "slow request",
      "failed request",
      "sampled request",
      "request with event",
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
