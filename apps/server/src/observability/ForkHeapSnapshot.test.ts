// @effect-diagnostics nodeBuiltinImport:off - mock the native snapshot and free-space APIs.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeV8 from "node:v8";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, vi } from "vite-plus/test";

vi.mock("node:fs/promises", () => ({ statfs: vi.fn(), rm: vi.fn() }));
vi.mock("node:os", () => ({ freemem: vi.fn() }));
vi.mock("node:v8", () => ({ getHeapStatistics: vi.fn(), writeHeapSnapshot: vi.fn() }));

it.effect.each(["available", "low", "unreadable", "low-memory"] as const)(
  "attempts at most one pressure snapshot with %s disk space",
  (space) =>
    Effect.gen(function* () {
      vi.resetModules();
      vi.mocked(NodeV8.getHeapStatistics).mockReturnValue({
        heap_size_limit: 4 * 1024 ** 3,
      } as ReturnType<typeof NodeV8.getHeapStatistics>);
      vi.mocked(NodeOS.freemem).mockReturnValue(
        space === "low-memory" ? 3 * 1024 ** 3 : 8 * 1024 ** 3,
      );
      const statfs = vi.mocked(NodeFSP.statfs).mockReset();
      if (space === "unreadable") statfs.mockRejectedValue(new Error("disk unavailable"));
      else
        statfs.mockResolvedValue({
          bavail: space === "low" ? 1 : 20 * 1024 ** 2,
          bsize: 1024,
        } as Awaited<ReturnType<typeof NodeFSP.statfs>>);
      const write = vi.mocked(NodeV8.writeHeapSnapshot).mockReset();
      const snapshot = yield* Effect.promise(() => import("./ForkHeapSnapshot.ts"));
      yield* snapshot.check(2 * 1024 ** 3, "/test/logs");
      expect(statfs).not.toHaveBeenCalled();
      yield* snapshot.check(2.4 * 1024 ** 3, "/test/logs");
      expect(statfs).toHaveBeenCalledTimes(space === "low-memory" ? 0 : 1);
      expect(write).toHaveBeenCalledTimes(space === "available" ? 1 : 0);
      yield* snapshot.check(4 * 1024 ** 3, "/test/logs");
      expect(statfs).toHaveBeenCalledTimes(space === "low-memory" ? 0 : 1);
      expect(write).toHaveBeenCalledTimes(space === "available" ? 1 : 0);
      if (space === "available") {
        expect(write).toHaveBeenCalledWith(
          expect.stringMatching(/^\/test\/logs\/heap-.*\.heapsnapshot$/),
        );
      }
    }),
);
