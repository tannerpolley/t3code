import { PreviewAutomationFileUnavailableError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { issueAssetUrl } from "../../../assets/AssetAccess.ts";
import * as ServerConfig from "../../../config.ts";

type IssuePreviewFileUrl = (
  threadId: ThreadId,
  filePath: string,
) => Effect.Effect<string, PreviewAutomationFileUnavailableError>;

/**
 * Issues the URL `preview_open` loads for a local file `path`. A reference so the preview tools
 * keep their upstream dependencies; `server.ts` provides `layer`, and without it file opens fail.
 */
export const PreviewFileUrls = Context.Reference<IssuePreviewFileUrl>(
  "t3/mcp/toolkits/preview/PreviewFileUrls",
  {
    defaultValue: () => (_threadId, filePath) =>
      Effect.fail(
        new PreviewAutomationFileUnavailableError({
          path: filePath,
          reason: "this server cannot serve local files.",
        }),
      ),
  },
);

/**
 * Serves a local file through a signed asset URL. The environment's browser runs on this
 * machine, so it loads the file from this server's loopback origin.
 */
const issuePreviewFileUrl = Effect.fn("PreviewToolkit.issueFileUrl")(function* (
  threadId: ThreadId,
  filePath: string,
) {
  const path = yield* Path.Path;
  if (!path.isAbsolute(filePath)) {
    return yield* new PreviewAutomationFileUnavailableError({
      path: filePath,
      reason: "pass an absolute path.",
    });
  }
  const config = yield* ServerConfig.ServerConfig;
  // ponytail: served as a single file, so an HTML page's relative sibling assets
  // don't load; issue a workspace-file asset from the thread's workspace if that matters.
  const asset = yield* issueAssetUrl({
    resource: { _tag: "media-file", threadId, path: filePath },
  }).pipe(
    Effect.mapError(
      (error) =>
        new PreviewAutomationFileUnavailableError({ path: filePath, reason: error.message }),
    ),
  );
  return `http://127.0.0.1:${config.port}${asset.relativeUrl}`;
});

export const layer = Layer.effect(
  PreviewFileUrls,
  Effect.gen(function* () {
    const context =
      yield* Effect.context<Effect.Services<ReturnType<typeof issuePreviewFileUrl>>>();
    return (threadId, filePath) =>
      issuePreviewFileUrl(threadId, filePath).pipe(Effect.provideContext(context));
  }),
);
