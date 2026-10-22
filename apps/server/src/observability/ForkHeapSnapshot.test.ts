// @effect-diagnostics nodeBuiltinImport:off - mock the native snapshot and free-space APIs.
import * as NodeFS from "node:fs/promises";
import * as NodeV8 from "node:v8";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, vi } from "vite-plus/test";

vi.mock("node:fs/promises", () => ({ statfs: vi.fn(), rm: vi.fn() }));
vi.mock("node:v8", () => ({ getHeapStatistics: vi.fn(), writeHeapSnapshot: vi.fn() }));

it.effect.each(["available", "low", "unreadable"] as const)(
  "attempts at most one pressure snapshot with %s disk space",
  (space) =>
    Effect.gen(function* () {
      vi.resetModules();
      vi.mocked(NodeV8.getHeapStatistics).mockReturnValue({
        heap_size_limit: 4 * 1024 ** 3,
      } as ReturnType<typeof NodeV8.getHeapStatistics>);
      const statfs = vi.mocked(NodeFS.statfs).mockReset();
      if (space === "unreadable") statfs.mockRejectedValue(new Error("disk unavailable"));
      else
        statfs.mockResolvedValue({
          bavail: space === "low" ? 1 : 20 * 1024 ** 2,
          bsize: 1024,
        } as Awaited<ReturnType<typeof NodeFS.statfs>>);
      const write = vi.mocked(NodeV8.writeHeapSnapshot).mockReset();
      const snapshot = yield* Effect.promise(() => import("./ForkHeapSnapshot.ts"));
      yield* snapshot.check(2 * 1024 ** 3, "/test/logs");
      expect(statfs).not.toHaveBeenCalled();
      yield* snapshot.check(3 * 1024 ** 3, "/test/logs");
      yield* snapshot.check(4 * 1024 ** 3, "/test/logs");
      expect(statfs).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(space === "available" ? 1 : 0);
      if (space === "available") {
        expect(write).toHaveBeenCalledWith(
          expect.stringMatching(/^\/test\/logs\/heap-.*\.heapsnapshot$/),
        );
      }
    }),
);
