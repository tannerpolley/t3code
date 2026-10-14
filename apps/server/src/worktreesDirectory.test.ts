import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { PROJECT_LOCAL_WORKTREES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { managedWorktreesDirectories, resolveWorktreePath } from "./worktreesDirectory.ts";

it.layer(NodeServices.layer)("worktree locations", (it) => {
  it.effect("resolves default, custom, and project-local paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const repository = path.join(root, "repo");
      const defaultDir = path.join(root, "t3-home", "worktrees");
      const custom = path.join(root, "custom");
      const resolve = (setting: string, cwd = repository) =>
        resolveWorktreePath(
          setting,
          defaultDir,
          path,
          root,
          cwd,
          "feature/nested/branch",
          repository,
        );
      expect(resolve("")).toBe(path.join(defaultDir, "repo", "feature-nested-branch"));
      expect(resolve(custom)).toBe(path.join(custom, "repo", "feature-nested-branch"));
      expect(resolve("~/custom")).toBe(path.join(root, "custom", "repo", "feature-nested-branch"));
      expect(resolve(PROJECT_LOCAL_WORKTREES)).toBe(
        path.join(repository, ".worktrees", "feature-nested-branch"),
      );
      expect(resolve(PROJECT_LOCAL_WORKTREES, path.join(repository, "finance"))).toBe(
        path.join(repository, ".worktrees", "feature-nested-branch"),
      );
      expect(resolve("relative/folder")).toBeNull();
      expect(resolve(path.parse(root).root)).toBeNull();
      expect(
        resolveWorktreePath(PROJECT_LOCAL_WORKTREES, defaultDir, path, root, repository, "branch"),
      ).toBeNull();
    }),
  );
  it.effect("keeps old custom and project-local folders managed after changing location", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const oldCustom = path.join(root, "old-custom");
      const defaultDir = path.join(root, "home", "worktrees");
      const repository = path.join(root, "repo");
      expect(
        managedWorktreesDirectories(
          {
            worktreesDirectory: "",
            previousWorktreesDirectories: [oldCustom, PROJECT_LOCAL_WORKTREES, oldCustom],
          },
          defaultDir,
          path,
          root,
          [repository],
        ),
      ).toEqual([defaultDir, oldCustom, path.join(repository, ".worktrees")]);
    }),
  );
});
