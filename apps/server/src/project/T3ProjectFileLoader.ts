/**
 * T3ProjectFileLoader - Effect service that loads the checked-in `t3.json`
 * project file from a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers
 * can fall back to their defaults.
 *
 * @module T3ProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  T3_PROJECT_FILE_NAME,
  PROJECT_READ_FILE_MAX_BYTES,
  type T3ProjectFile,
  type ProjectReadFileResult,
} from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";

const decodeT3ProjectFileJson = Schema.decodeEffect(T3ProjectFileFromJson);

export class T3ProjectFileLoadError extends Schema.TaggedError<T3ProjectFileLoadError>()(
  "T3ProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${T3_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

/** Service tag for t3.json project file loading. */
export class T3ProjectFileLoader extends Context.Service<
  T3ProjectFileLoader,
  {
    /** Read the optional configuration; unreadable or invalid files fail. */
    readonly readFile: (
      workspaceRoot: string,
    ) => Effect.Effect<ProjectReadFileResult | null, T3ProjectFileLoadError>;
    /**
     * Load and decode `t3.json` at the workspace root.
     * Missing files resolve to none; unreadable or invalid files warn and resolve to none.
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<T3ProjectFile>>;
  }
>()("t3/project/T3ProjectFileLoader") {}

const logT3ProjectFileLoadError = (error: T3ProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const readAndDecode = Effect.fn("T3ProjectFileLoader.readAndDecode")(function* (
    workspaceRoot: string,
  ) {
    const filePath = path.join(workspaceRoot, T3_PROJECT_FILE_NAME);
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new T3ProjectFileLoadError({
                  operation: "read",
                  workspaceRoot,
                  filePath,
                  cause,
                }),
              ),
      }),
    );
    if (Option.isNone(raw)) return Option.none();
    const file = yield* decodeT3ProjectFileJson(raw.value).pipe(
      Effect.mapError(
        (cause) =>
          new T3ProjectFileLoadError({
            operation: "decode",
            workspaceRoot,
            filePath,
            cause,
          }),
      ),
    );
    return Option.some({ file, contents: raw.value });
  });

  const readFile: T3ProjectFileLoader["Service"]["readFile"] = Effect.fn(
    "T3ProjectFileLoader.readFile",
  )(function* (workspaceRoot) {
    const loaded = yield* readAndDecode(workspaceRoot);
    if (Option.isNone(loaded)) return null;
    const { contents } = loaded.value;
    const bytes = new TextEncoder().encode(contents);
    return {
      relativePath: T3_PROJECT_FILE_NAME,
      contents:
        bytes.length > PROJECT_READ_FILE_MAX_BYTES
          ? new TextDecoder().decode(bytes.subarray(0, PROJECT_READ_FILE_MAX_BYTES))
          : contents,
      byteLength: bytes.length,
      truncated: bytes.length > PROJECT_READ_FILE_MAX_BYTES,
    };
  });

  const load: T3ProjectFileLoader["Service"]["load"] = Effect.fn("T3ProjectFileLoader.load")(
    (workspaceRoot) =>
      readAndDecode(workspaceRoot).pipe(
        Effect.map(Option.map(({ file }) => file)),
        Effect.catchTags({
          T3ProjectFileLoadError: (error) =>
            logT3ProjectFileLoadError(error).pipe(Effect.as(Option.none<T3ProjectFile>())),
        }),
      ),
  );

  return T3ProjectFileLoader.of({ load, readFile });
});

export const layer = Layer.effect(T3ProjectFileLoader, make);
