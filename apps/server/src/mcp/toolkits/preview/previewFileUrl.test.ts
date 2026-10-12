import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { PreviewAutomationFileUnavailableError, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../../../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../../../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as PreviewFileUrl from "./previewFileUrl.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-preview-file-url-test-",
});
const layer = PreviewFileUrl.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeHttpPlatform.layer,
      configLayer,
      WorkspacePaths.layer,
      ProjectFaviconResolver.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(T3ProjectFileLoader.layer),
      ),
      ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
      ServerSettings.layerTest(),
      // Only tool-output image assets read the orchestrator; file paths never do.
      Layer.mock(Orchestrator.OrchestratorV2)({}),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("issues a loopback asset URL for an absolute path and rejects a relative one", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-preview-open-file-" });
    const filePath = path.join(dir, "deck.pdf");
    yield* fs.writeFileString(filePath, "%PDF-1.4");
    const issueFileUrl = yield* PreviewFileUrl.PreviewFileUrls;
    const threadId = ThreadId.make("thread-1");

    expect(yield* issueFileUrl(threadId, filePath)).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/api\/assets\/[^/]+\/deck\.pdf$/,
    );
    expect(yield* issueFileUrl(threadId, "deck.pdf").pipe(Effect.flip)).toBeInstanceOf(
      PreviewAutomationFileUnavailableError,
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
