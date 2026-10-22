// @effect-diagnostics nodeBuiltinImport:off - mock the native snapshot and free-space APIs.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeV8 from "node:v8";

import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { expect, vi } from "vite-plus/test";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), statfs: vi.fn(), rm: vi.fn() }));
vi.mock("node:os", () => ({ freemem: vi.fn() }));
vi.mock("node:v8", () => ({ getHeapStatistics: vi.fn(), writeHeapSnapshot: vi.fn() }));

it.effect.each([
  "available",
  "low-disk",
  "unreadable-disk",
  "low-memory",
  "darwin",
  "missing-memory",
  "unreadable-memory",
] as const)("guards a once-per-process pressure snapshot (%s)", (space) =>
  Effect.gen(function* () {
    vi.resetModules();
    vi.mocked(NodeV8.getHeapStatistics).mockReturnValue({
      heap_size_limit: 4 * 1024 ** 3,
    } as ReturnType<typeof NodeV8.getHeapStatistics>);
    // Linux must use reclaimable memory even when free memory alone is too low.
    const freemem = vi
      .mocked(NodeOS.freemem)
      .mockReset()
      .mockReturnValue(space === "darwin" ? 8 * 1024 ** 3 : 1);
    const readFile = vi.mocked(NodeFSP.readFile).mockReset();
    if (space === "unreadable-memory") readFile.mockRejectedValue(new Error("meminfo unavailable"));
    else
      readFile.mockResolvedValue(
        space === "missing-memory"
          ? "MemFree: 1 kB\n"
          : `MemFree: 1 kB\nMemAvailable: ${space === "low-memory" ? 3 * 1024 ** 2 : 8 * 1024 ** 2} kB\n`,
      );
    const statfs = vi.mocked(NodeFSP.statfs).mockReset();
    if (space === "unreadable-disk") statfs.mockRejectedValue(new Error("disk unavailable"));
    else
      statfs.mockResolvedValue({
        bavail: space === "low-disk" ? 1 : 20 * 1024 ** 2,
        bsize: 1024,
      } as Awaited<ReturnType<typeof NodeFSP.statfs>>);
    const write = vi.mocked(NodeV8.writeHeapSnapshot).mockReset();
    const snapshot = yield* Effect.promise(() => import("./ForkHeapSnapshot.ts"));
    yield* snapshot.check(2 * 1024 ** 3, "/test/logs");
    expect(statfs).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    yield* snapshot.check(2.4 * 1024 ** 3, "/test/logs");
    const enoughMemory = !["low-memory", "missing-memory", "unreadable-memory"].includes(space);
    expect(statfs).toHaveBeenCalledTimes(enoughMemory ? 1 : 0);
    expect(write).toHaveBeenCalledTimes(space === "available" || space === "darwin" ? 1 : 0);
    if (space === "darwin") {
      expect(freemem).toHaveBeenCalledOnce();
      expect(readFile).not.toHaveBeenCalled();
    } else {
      expect(freemem).not.toHaveBeenCalled();
      expect(readFile).toHaveBeenCalledWith("/proc/meminfo", "utf8");
    }
    if (space === "low-memory") {
      readFile.mockResolvedValue(`MemAvailable: ${6 * 1024 ** 2} kB\n`);
      yield* snapshot.check(4 * 1024 ** 3, "/test/logs");
      expect(write).toHaveBeenCalledOnce();
    }
    yield* snapshot.check(4 * 1024 ** 3, "/test/logs");
    expect(statfs).toHaveBeenCalledTimes(enoughMemory || space === "low-memory" ? 1 : 0);
    expect(write).toHaveBeenCalledTimes(
      ["available", "darwin", "low-memory"].includes(space) ? 1 : 0,
    );
    if (write.mock.calls.length > 0) {
      expect(write).toHaveBeenCalledWith(
        expect.stringMatching(/^\/test\/logs\/heap-.*\.heapsnapshot$/),
      );
    }
  }).pipe(Effect.provideService(HostProcess.Platform, space === "darwin" ? "darwin" : "linux")),
);
