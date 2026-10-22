// @effect-diagnostics nodeBuiltinImport:off - tests inject swaps at the native open boundary.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeFSP from "node:fs/promises";
import {
  AssetPreviewTypeValidationError,
  AssetMediaSizeValidationError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";

import { describe, expect, it } from "@effect/vitest";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as Path from "effect/Path";

import { vi } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { assetFileResponse } from "../http.ts";
import {
  ASSET_ROUTE_PREFIX,
  MARKDOWN_MEDIA_MAX_BYTES,
  issueAssetUrl,
  resolveAsset,
} from "./AssetAccess.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) };
});

const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-asset-access-test-",
});
const screenshotPng = new Uint8Array(24);
screenshotPng.set([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
new DataView(screenshotPng.buffer).setUint32(16, 390);
new DataView(screenshotPng.buffer).setUint32(20, 844);
const screenshotItem = {
  id: TurnItemId.make("tool-screenshot"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  toolName: "mcp__t3-code__device_screenshot",
  input: { deviceId: "phone" },
  output: {
    content: [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from(screenshotPng).toString("base64"),
        },
      },
    ],
  },
  startedAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
};

const oversizedScreenshotItem = {
  ...screenshotItem,
  id: TurnItemId.make("tool-screenshot-oversized"),
  output: {
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "A".repeat(14 * 1024 * 1024) },
      },
    ],
  },
};

const layerTest = Layer.mergeAll(
  NodeHttpPlatform.layer,
  Layer.mock(Orchestrator.OrchestratorV2)({
    getTurnItem: ({ itemId }) =>
      Effect.succeed(
        itemId === screenshotItem.id
          ? screenshotItem
          : itemId === oversizedScreenshotItem.id
            ? oversizedScreenshotItem
            : null,
      ),
  }),
  layerConfig,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  NativeAppIconResolver.layer.pipe(Layer.provide(layerConfig)),
  ServerSecretStore.layer.pipe(Layer.provide(layerConfig)),
).pipe(Layer.provideMerge(NodeServices.layer));

describe("AssetAccess", () => {
  it.effect(
    "refuses document and audio files in Markdown embeds without removing their preview support",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-markdown-types-" });
        for (const name of ["report.html", "report.pdf", "recording.mp3"]) {
          const filePath = path.join(outside, name);
          yield* fs.writeFileString(filePath, "preview");
          const resource = {
            _tag: "media-file" as const,
            threadId: ThreadId.make("thread"),
            path: filePath,
          };
          expect(
            yield* Effect.flip(issueAssetUrl({ resource: { ...resource, mediaOnly: true } })),
          ).toBeInstanceOf(AssetPreviewTypeValidationError);
          expect((yield* issueAssetUrl({ resource })).relativeUrl).toContain(ASSET_ROUTE_PREFIX);
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("caps Markdown media when signing, resolving, and serving a file that grew", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-markdown-size-" });
      const filePath = path.join(outside, "clip.mp4");
      yield* fs.writeFileString(filePath, "video");
      const resource = {
        _tag: "media-file" as const,
        threadId: ThreadId.make("thread"),
        path: filePath,
        mediaOnly: true,
      };
      const resize = (size: number) => Effect.promise(() => NodeFSP.truncate(filePath, size));
      yield* resize(MARKDOWN_MEDIA_MAX_BYTES);
      const result = yield* issueAssetUrl({ resource });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      const resolve = () => resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));
      const asset = yield* resolve();
      expect(asset?.kind).toBe("file");
      if (asset?.kind !== "file") throw new Error("Expected signed media file");
      yield* resize(MARKDOWN_MEDIA_MAX_BYTES + 1);
      expect(yield* Effect.flip(issueAssetUrl({ resource }))).toBeInstanceOf(
        AssetMediaSizeValidationError,
      );
      // A request after the growth no longer resolves, so the asset route answers 404.
      expect(yield* resolve()).toBeNull();
      // Only a file that grows between resolving and serving reaches the 413.
      expect((yield* assetFileResponse(asset)).status).toBe(413);
    }).pipe(Effect.provide(layerTest)),
  );
});
