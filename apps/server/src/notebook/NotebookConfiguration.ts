// @effect-diagnostics nodeBuiltinImport:off
// Trusted profiles and the ownership journal are outside workspace-controlled files.
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { NotebookError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as NotebookService from "./NotebookService.ts";
import * as JupyterTransport from "./JupyterTransport.ts";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const profile = Schema.Struct({
  root: Schema.String,
  url: Schema.String,
  secretName: Schema.String,
  kernelName: Schema.String,
  interpreter: Schema.String,
  imports: Schema.Array(Schema.String),
});
const entries = Schema.Array(
  Schema.Struct({ root: Schema.String, profileHash: Schema.String, id: Schema.String }),
);
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const server = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const transport = yield* JupyterTransport.JupyterTransport;
  const lock = Semaphore.makeUnsafe(1);
  const reconciled = new Set<string>();
  const journalPath = NodePath.join(server.baseDir, "notebook-kernels.json");
  const read = Effect.fn("NotebookConfiguration.read")(function* <A>(
    path: string,
    schema: Schema.Codec<A>,
    fallback: A,
  ) {
    if (!(yield* fs.exists(path))) return fallback;
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
      yield* fs.readFileString(path),
    );
  });
  const journalResult = yield* read(journalPath, entries, []).pipe(Effect.result);
  let journal = journalResult._tag === "Success" ? journalResult.success : [];
  const persist = Effect.fn("NotebookConfiguration.persist")(function* (next: typeof entries.Type) {
    const temp = `${journalPath}.${NodeCrypto.randomUUID()}.tmp`;
    yield* Effect.gen(function* () {
      yield* fs.writeFileString(temp, encodeJson(next), { flag: "wx", mode: 0o600 });
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* fs.rename(temp, journalPath);
          journal = next;
        }),
      );
    }).pipe(
      Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)),
      Effect.mapError(() => new NotebookError({ reason: "unavailable" })),
    );
  });
  const endpoint = Effect.fn("NotebookConfiguration.endpoint")(function* (root: string) {
    return yield* lock
      .withPermit(
        Effect.gen(function* () {
          if (journalResult._tag === "Failure")
            return yield* new NotebookError({ reason: "unavailable" });
          const configured = yield* read(
            NodePath.join(server.baseDir, "notebooks.json"),
            Schema.Array(profile),
            [],
          );
          const matches = configured.filter((p) => p.root === root);
          const selected = matches[0];
          if (
            matches.length !== 1 ||
            !selected ||
            !NodePath.isAbsolute(selected.interpreter) ||
            !/^[a-zA-Z0-9_-]{1,100}$/.test(selected.secretName) ||
            !selected.kernelName ||
            selected.imports.some((name) => !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name))
          )
            return yield* new NotebookError({ reason: "unavailable" });
          const secret = yield* secrets.get(selected.secretName);
          if (Option.isNone(secret)) return yield* new NotebookError({ reason: "unavailable" });
          const value = {
            url: selected.url,
            token: new TextDecoder().decode(secret.value),
            kernelName: selected.kernelName,
            interpreter: selected.interpreter,
            imports: selected.imports,
          };
          yield* Effect.try({
            try: () => JupyterTransport.endpointUrl(value, ""),
            catch: () => new NotebookError({ reason: "unavailable" }),
          });
          const profileHash = NodeCrypto.createHash("sha256")
            .update(encodeJson(selected))
            .digest("hex");
          if (!reconciled.has(root)) {
            for (const prior of journal.filter((entry) => entry.root === root)) {
              if (prior.profileHash !== profileHash)
                return yield* new NotebookError({ reason: "unavailable" });
              yield* transport.control(value, prior.id, "shutdown");
              yield* persist(journal.filter((entry) => entry !== prior));
            }
            reconciled.add(root);
          }
          return { ...value, profileHash };
        }),
      )
      .pipe(Effect.mapError(() => new NotebookError({ reason: "unavailable" })));
  });
  return NotebookService.NotebookConfiguration.of({
    endpoint,
    owned: Effect.fn("NotebookConfiguration.owned")((root, profileHash, id) =>
      lock.withPermit(Effect.suspend(() => persist([...journal, { root, id, profileHash }]))),
    ),
    released: Effect.fn("NotebookConfiguration.released")((root, id) =>
      lock.withPermit(
        Effect.suspend(() =>
          persist(journal.filter((entry) => entry.root !== root || entry.id !== id)),
        ),
      ),
    ),
  });
});
export const layer = Layer.effect(NotebookService.NotebookConfiguration, make);
