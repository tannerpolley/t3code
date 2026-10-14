import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(T3ProjectFileLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-file-",
  });
});

const writeProjectFile = Effect.fn("writeProjectFile")(function* (cwd: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, "t3.json"), contents).pipe(Effect.orDie);
});

it.layer(layerTest)("T3ProjectFileLoader", (it) => {
  describe("readFile", () => {
    it.effect("returns null without logs or failed spans when t3.json is absent", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        const logs: unknown[] = [];
        const spans: Tracer.NativeSpan[] = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              spans.push(span);
            };
            return span;
          },
        });
        const logger = Logger.make((entry) => {
          logs.push(entry);
        });
        const result = yield* loader
          .readFile(cwd)
          .pipe(
            Effect.withSpan("ws.rpc.projects.readT3ProjectFile"),
            Effect.withTracer(tracer),
            Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          );
        const loaded = yield* loader
          .load(cwd)
          .pipe(
            Effect.withTracer(tracer),
            Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          );
        expect(Option.isNone(loaded)).toBe(true);
        expect(result).toBeNull();
        expect(logs).toEqual([]);
        expect(spans.length).toBeGreaterThan(0);
        for (const span of spans) {
          expect(span.status).toMatchObject({ _tag: "Ended", exit: { _tag: "Success" } });
        }
      }),
    );

    it.effect("returns the original JSONC contents of a valid file", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        const contents = '{ // café\n "scripts": [], }';
        yield* writeProjectFile(cwd, contents);
        const result = yield* loader.readFile(cwd);
        expect(result).toEqual({
          relativePath: "t3.json",
          contents,
          byteLength: new TextEncoder().encode(contents).byteLength,
          truncated: false,
        });
      }),
    );

    it.effect("fails to decode malformed or schema-invalid files", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        for (const contents of ["{ not json", '{ "scripts": [{ "name": "Dev" }] }']) {
          yield* writeProjectFile(cwd, contents);
          const error = yield* loader.readFile(cwd).pipe(Effect.flip);
          expect(error).toBeInstanceOf(T3ProjectFileLoader.T3ProjectFileLoadError);
          expect(error).toMatchObject({ operation: "decode", workspaceRoot: cwd });
        }
      }),
    );

    it.effect("preserves permission errors rather than treating them as absence", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir;
        const cause = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "readFileString",
          pathOrDescriptor: `${cwd}/t3.json`,
        });
        const loader = yield* T3ProjectFileLoader.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: () => Effect.fail(cause),
          }),
        );
        const error = yield* loader.readFile(cwd).pipe(Effect.flip);
        expect(error).toMatchObject({ operation: "read", workspaceRoot: cwd, cause });
      }),
    );

    it.effect("fails when t3.json cannot be read as a file", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fs.makeDirectory(path.join(cwd, "t3.json"));
        const error = yield* loader.readFile(cwd).pipe(Effect.flip);
        expect(error).toBeInstanceOf(T3ProjectFileLoader.T3ProjectFileLoadError);
        expect(error).toMatchObject({ operation: "read", workspaceRoot: cwd });
      }),
    );
  });

  describe("load", () => {
    it.effect("loads and decodes a valid t3.json", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(
          cwd,
          `{
            // JSONC is tolerated
            "iconPath": "assets/logo.svg",
            "scripts": [{ "name": "Dev", "command": "pnpm dev" }],
          }`,
        );

        const loaded = yield* loader.load(cwd);

        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value.iconPath).toBe("assets/logo.svg");
          expect(loaded.value.scripts).toEqual([{ name: "Dev", command: "pnpm dev" }]);
        }
      }),
    );

    it.effect("returns none when t3.json is missing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for malformed JSON without failing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, "{ not json");

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for schema-invalid files without failing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, '{ "scripts": [{ "name": "Dev" }] }');

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );
  });
});
