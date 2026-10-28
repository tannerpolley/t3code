// @effect-diagnostics nodeBuiltinImport:off
// Journal fixtures hash exactly the trusted local profile.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as NotebookConfiguration from "./NotebookConfiguration.ts";
import * as NotebookService from "./NotebookService.ts";
import * as JupyterTransport from "./JupyterTransport.ts";

it.effect(
  "reconciles only journaled owned kernels, keeps credentials server-side and rejects unsafe configuration",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const profile = {
        root,
        url: "http://127.0.0.1:8899",
        secretName: "project-jupyter",
        kernelName: "python3",
        interpreter: "/project/python",
        imports: ["numpy"],
      };
      const profileHash = NodeCrypto.createHash("sha256")
        .update(JSON.stringify(profile))
        .digest("hex");
      yield* fs.writeFileString(`${root}/notebooks.json`, JSON.stringify([profile]));
      yield* fs.writeFileString(
        `${root}/notebook-kernels.json`,
        JSON.stringify([{ root, profileHash, id: "owned-before-crash" }]),
      );
      const deleted: string[] = [];
      const services = yield* Layer.build(
        NotebookConfiguration.layer.pipe(
          Layer.provide(ServerConfig.layerTest(root, root)),
          Layer.provide(
            Layer.mock(ServerSecretStore.ServerSecretStore)({
              get: () => Effect.succeedSome(new TextEncoder().encode("private-token")),
            }),
          ),
          Layer.provide(
            Layer.mock(JupyterTransport.JupyterTransport)({
              control: (_endpoint, id) =>
                Effect.sync(() => {
                  deleted.push(id);
                }),
            }),
          ),
        ),
      );
      const config = yield* NotebookService.NotebookConfiguration.pipe(Effect.provide(services));
      const endpoint = yield* config.endpoint(root);
      expect(endpoint.interpreter).toBe("/project/python");
      expect(deleted).toEqual(["owned-before-crash"]);
      yield* config.endpoint(root);
      expect(deleted).toHaveLength(1);
      yield* config.owned(root, "new-owned");
      const journal = yield* fs.readFileString(`${root}/notebook-kernels.json`);
      expect(journal).toContain("new-owned");
      expect(journal).not.toContain("private-token");
      yield* config.released(root, "new-owned");
      expect(JSON.parse(yield* fs.readFileString(`${root}/notebook-kernels.json`))).toEqual([]);
      for (const url of [
        "http://localhost:8899",
        "http://127.1:8899",
        "http://127.0.0.1:8899?token=x",
        "http://user@127.0.0.1:8899",
        "https://127.0.0.1:8899",
      ]) {
        yield* fs.writeFileString(`${root}/notebooks.json`, JSON.stringify([{ ...profile, url }]));
        expect(yield* config.endpoint(root).pipe(Effect.flip)).toMatchObject({
          reason: "unavailable",
        });
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
