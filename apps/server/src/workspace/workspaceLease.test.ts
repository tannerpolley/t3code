import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";

import { withWorkspaceLease } from "./workspaceLease.ts";

it.effect.each(["existing", "missing"] as const)(
  "serializes aliased leases for an %s checkout, including after recreation",
  (state) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "workspace-lease-" });
      yield* fs.makeDirectory(`${root}/repo`);
      yield* fs.symlink(`${root}/repo`, `${root}/linked`);
      const physical = `${root}/repo/.worktrees/feature`;
      const alias = `${root}/linked/.worktrees/feature`;
      if (state === "existing") yield* fs.makeDirectory(physical, { recursive: true });
      const release = yield* Deferred.make<void>();
      const calls: string[] = [];
      const holder = yield* withWorkspaceLease(
        alias,
        Effect.gen(function* () {
          calls.push("holder");
          yield* Deferred.await(release);
        }),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      expect(calls).toEqual(["holder"]);
      if (state === "missing") yield* fs.makeDirectory(physical, { recursive: true });
      const contender = yield* withWorkspaceLease(
        physical,
        Effect.sync(() => calls.push("contender")),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      expect(calls).toEqual(["holder"]);
      yield* withWorkspaceLease(
        `${root}/other`,
        Effect.sync(() => calls.push("other")),
      );
      expect(calls).toEqual(["holder", "other"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(contender);
      expect(calls).toEqual(["holder", "other", "contender"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
