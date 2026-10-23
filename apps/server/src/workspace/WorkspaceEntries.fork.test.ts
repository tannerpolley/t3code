// @effect-diagnostics nodeBuiltinImport:off

import * as NodeServices from "@effect/platform-node/NodeServices";

import { it, afterEach, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-entries-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn(function* (opts?: { prefix?: string; git?: boolean }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: opts?.prefix ?? "t3code-workspace-entries-",
  });
  if (opts?.git) {
    yield* git(dir, ["init"]);
  }
  return dir;
});

function writeTextFile(
  cwd: string,
  relativePath: string,
  contents = "",
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });
}

const git = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "WorkspaceEntries.test.git",
      command: "git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const searchWorkspaceEntries = (input: {
  cwd: string;
  query: string;
  limit: number;
  kind?: "file" | "directory";
}) =>
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    return yield* workspaceEntries.search(input);
  });

it.layer(layerTest, { excludeTestServices: true })("WorkspaceEntries", (it) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("search", () => {
    it.effect("excludes project-local worktrees from listing, indexing and content search", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        yield* writeTextFile(cwd, ".git/info/exclude", ".worktrees/\n");
        yield* writeTextFile(cwd, ".worktrees/.ignore", "*\n");
        yield* writeTextFile(cwd, ".worktrees/feature/duplicate.ts", "worktree-secret");
        yield* writeTextFile(cwd, "src/keep.ts", "worktree-secret");
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const listed = yield* entries.list({ cwd, directoryPath: "" });
        expect(listed.entries.some((entry) => entry.path === ".worktrees")).toBe(false);
        const searched = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        expect(searched.entries.some((entry) => entry.path.startsWith(".worktrees"))).toBe(false);
        const contents = yield* entries.searchContents({
          cwd,
          query: "worktree-secret",
          limit: 100,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
        });
        expect(contents.matches.map((match) => match.path)).toEqual(["src/keep.ts"]);
      }),
    );
  });
});
