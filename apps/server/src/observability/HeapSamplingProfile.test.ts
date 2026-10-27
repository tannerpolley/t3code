// @effect-diagnostics nodeBuiltinImport:off - mock the inspector and filesystem APIs.
import * as NodeFSP from "node:fs/promises";
import * as NodeV8 from "node:v8";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, vi } from "vite-plus/test";

const inspector = vi.hoisted(() => ({ post: vi.fn(), connect: vi.fn() }));
vi.mock("node:inspector", () => ({
  Session: class {
    connect = inspector.connect;
    post = inspector.post;
  },
}));
vi.mock("node:fs/promises", () => ({ statfs: vi.fn(), writeFile: vi.fn() }));
vi.mock("node:v8", () => ({ getHeapStatistics: vi.fn() }));

it.effect("writes one sampling profile only after heap pressure crosses the threshold", () =>
  Effect.gen(function* () {
    vi.resetModules();
    inspector.connect.mockReset();
    inspector.post.mockReset().mockImplementation((method, ...args) => {
      const callback = args.at(-1);
      callback(null, method === "HeapProfiler.getSamplingProfile" ? { profile: { head: {} } } : {});
    });
    vi.mocked(NodeV8.getHeapStatistics).mockReturnValue({
      heap_size_limit: 1000,
    } as ReturnType<typeof NodeV8.getHeapStatistics>);
    vi.mocked(NodeFSP.statfs).mockResolvedValue({
      bavail: 2 * 1024 ** 3,
      bsize: 1,
    } as Awaited<ReturnType<typeof NodeFSP.statfs>>);
    const write = vi.mocked(NodeFSP.writeFile).mockReset().mockResolvedValue(undefined);
    const profiler = yield* Effect.promise(() => import("./HeapSamplingProfile.ts"));
    yield* profiler.start;
    yield* profiler.start;
    yield* profiler.check(599, "/test/logs");
    expect(write).not.toHaveBeenCalled();
    yield* profiler.check(600, "/test/logs");
    yield* profiler.check(900, "/test/logs");
    expect(inspector.connect).toHaveBeenCalledOnce();
    expect(inspector.post.mock.calls.map(([method]) => method)).toEqual([
      "HeapProfiler.startSampling",
      "HeapProfiler.getSamplingProfile",
    ]);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(
      expect.stringMatching(/^\/test\/logs\/heap-.*\.heapprofile$/),
      JSON.stringify({ head: {} }),
    );
  }),
);

it.effect("skips the profile when disk space is low", () =>
  Effect.gen(function* () {
    vi.resetModules();
    inspector.post.mockReset().mockImplementation((_method, ...args) => args.at(-1)(null, {}));
    vi.mocked(NodeV8.getHeapStatistics).mockReturnValue({
      heap_size_limit: 1000,
    } as ReturnType<typeof NodeV8.getHeapStatistics>);
    vi.mocked(NodeFSP.statfs).mockResolvedValue({ bavail: 1, bsize: 1 } as Awaited<
      ReturnType<typeof NodeFSP.statfs>
    >);
    const write = vi.mocked(NodeFSP.writeFile).mockReset();
    const profiler = yield* Effect.promise(() => import("./HeapSamplingProfile.ts"));
    yield* profiler.start;
    yield* profiler.check(600, "/test/logs");
    yield* profiler.check(900, "/test/logs");
    expect(inspector.post).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  }),
);
