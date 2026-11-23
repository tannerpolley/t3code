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

const unsampledTrace = "00000000000000000000000000000001";
const sampledTrace = "00000000000000000000000000000064";

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
    }).pipe(
      Effect.withParentSpan(Tracer.externalSpan({ traceId: unsampledTrace, spanId: "1" })),
      Effect.withTracer(tracer),
    );
    yield* effect;

    const rendererRecord: OtlpTraceRecord = {
      type: "otlp-span",
      traceId: unsampledTrace,
      spanId: "2",
      sampled: true,
      kind: "internal",
      name: "EnvironmentRpc.currentSession",
      startTimeUnixNano: "1",
      endTimeUnixNano: "1000001",
      durationMs: 1,
      attributes: {},
      resourceAttributes: {},
      scope: { attributes: {} },
      events: [],
      links: [],
    };
    yield* BrowserTraceCollector.make(sink).record([
      rendererRecord,
      ...decodeOtlpTraceRecords(
        cast<unknown, OtlpTracer.TraceData>({
          resourceSpans: [{ scopeSpans: [{ spans: [{ name: "missing trace ID" }] }] }],
        }),
      ),
      { ...rendererRecord, spanId: "3", name: "slow request", durationMs: 1_000 },
      { ...rendererRecord, spanId: "4", name: "failed request", status: { code: "2" } },
      { ...rendererRecord, spanId: "5", name: "sampled request", traceId: sampledTrace },
      {
        ...rendererRecord,
        spanId: "6",
        name: "sampled child",
        traceId: sampledTrace,
        parentSpanId: "5",
      },
      {
        ...rendererRecord,
        spanId: "7",
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
    ]);
    expect(forwarded.every((span) => span.status._tag === "Ended")).toBe(true);
    expect(names).toEqual([
      "ProviderTurnStartService.start",
      "contended query",
      "failed query",
      "slow request",
      "failed request",
      "sampled request",
      "sampled child",
      "request with event",
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
