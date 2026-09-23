import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PreviewAutomationTimeoutError,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
} from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { claimPreviewRecording, invoke, normalizePreviewOpenInput } from "./handlers.ts";

describe("stuck tab recovery", () => {
  const scope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["preview"] as const),
    issuedAt: 1,
  };
  const stuckTab = PreviewTabId.make("tab_stuck");
  const timeout = (operation: "open" | "navigate") =>
    new PreviewAutomationTimeoutError({
      ...scope,
      operation,
      clientId: "client-1",
      connectionId: "connection-1",
      requestId: "preview-1",
      timeoutMs: 15_000,
    });

  /** A broker whose current tab is `tab_stuck` and whose open/navigate calls follow `outcomes`. */
  const run = (
    operation: "open" | "navigate",
    input: object,
    outcomes: ReadonlyArray<"timeout" | "ok">,
  ) => {
    const calls: Array<{ operation: string; input: unknown; tabId?: string }> = [];
    const broker = {
      invoke: (request: PreviewAutomationBroker.PreviewAutomationInvokeInput) => {
        request.onTargetTab?.(request.tabId ?? stuckTab);
        const outcome = outcomes[calls.length] ?? "ok";
        calls.push({
          operation: request.operation,
          input: request.input,
          ...(request.tabId === undefined ? {} : { tabId: request.tabId }),
        });
        return outcome === "timeout"
          ? Effect.fail(timeout(operation))
          : Effect.succeed({ tabId: stuckTab });
      },
    } as unknown as PreviewAutomationBroker.PreviewAutomationBroker["Service"];
    return invoke(operation, input).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
      Effect.result,
      Effect.map((result) => ({ result, calls })),
    );
  };

  it.effect("hard-reloads the same tab once, then retries the timed-out open", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* run("open", { url: "http://localhost:8791/" }, ["timeout"]);
      expect(result._tag).toBe("Success");
      expect(calls).toEqual([
        { operation: "open", input: { url: "http://localhost:8791/" } },
        {
          operation: "navigate",
          input: { reload: "bypassCache", readiness: "none" },
          tabId: stuckTab,
        },
        { operation: "open", input: { url: "http://localhost:8791/" }, tabId: stuckTab },
      ]);
    }),
  );

  it.effect("returns the timeout after one failed retry instead of looping", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* run("navigate", { url: "http://localhost:8791/" }, [
        "timeout",
        "ok",
        "timeout",
      ]);
      expect(result._tag).toBe("Failure");
      expect(calls.map((call) => call.operation)).toEqual(["navigate", "navigate", "navigate"]);
    }),
  );

  it.effect("does not retry an open that was creating a new tab", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* run("open", { reuseExistingTab: false }, ["timeout"]);
      expect(result._tag).toBe("Failure");
      expect(calls).toHaveLength(1);
    }),
  );
});

describe("normalizePreviewOpenInput", () => {
  it("leaves an unstated visibility for the client preference to decide", () => {
    // Filling `open` in here would outrank `browserAutoShowFloatingPreview`,
    // which is desktop-local and cannot be read from the server.
    expect(normalizePreviewOpenInput({})).toEqual({ reuseExistingTab: true });
  });

  it("preserves an explicit background-only opt-out", () => {
    expect(normalizePreviewOpenInput({ open: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
  });

  it("supports show as a legacy alias while preferring open", () => {
    expect(normalizePreviewOpenInput({ show: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
    expect(normalizePreviewOpenInput({ open: true, show: false })).toEqual({
      open: true,
      reuseExistingTab: true,
      show: true,
    });
  });
});

describe("claimPreviewRecording", () => {
  it.effect("overlapping and repeated claims return the same retained recording", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const uploadedAttachmentId = createPendingAttachmentId(".webm");
      const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(pendingPath, "video!");
      const response = {
        id: "desktop-recording",
        tabId: "tab-1",
        path: "/desktop/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 6,
        createdAt: "2026-09-07T00:00:00.000Z",
        uploadedAttachmentId,
      };
      const claim = claimPreviewRecording(ThreadId.make("thread-1"), response);
      const [first, second] = yield* Effect.all([claim, claim], { concurrency: "unbounded" });
      expect(first).toEqual(second);
      expect(yield* claim).toEqual(first);
      expect(yield* fileSystem.readFileString(first.path)).toBe("video!");
      expect(yield* fileSystem.exists(pendingPath)).toBe(false);
      const wrongThread = yield* claimPreviewRecording(ThreadId.make("thread-2"), response).pipe(
        Effect.result,
      );
      expect(wrongThread._tag).toBe("Failure");
      const wrongPath = yield* claimPreviewRecording(ThreadId.make("thread-1"), {
        ...response,
        uploadedAttachmentId: `../${uploadedAttachmentId}`,
      }).pipe(Effect.result);
      expect(wrongPath._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([6, 5])(
    "claims only a complete uploaded recording (reported bytes: %s)",
    (sizeBytes) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const uploadedAttachmentId = createPendingAttachmentId(".webm");
        const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
        yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(pendingPath, "video!");
        const response = {
          id: "desktop-recording",
          tabId: "tab-1",
          path: "/desktop/recording.webm",
          mimeType: "video/webm",
          sizeBytes,
          createdAt: "2026-09-07T00:00:00.000Z",
          uploadedAttachmentId,
        };
        const result = yield* claimPreviewRecording(ThreadId.make("thread-1"), response).pipe(
          Effect.result,
        );
        if (sizeBytes === 6) {
          expect(result._tag).toBe("Success");
          if (result._tag !== "Success") return;
          expect(result.success.path).not.toBe(response.path);
          expect(parseThreadSegmentFromAttachmentId(result.success.id)).toBe("thread-1");
          expect(yield* fileSystem.readFileString(result.success.path)).toBe("video!");
          expect(yield* fileSystem.exists(pendingPath)).toBe(false);
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag !== "Failure") return;
          expect(result.failure._tag).toBe("PreviewAutomationRecordingTransferError");
          expect(yield* fileSystem.exists(pendingPath)).toBe(true);
        }
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("reports an older desktop without returning its inaccessible path", () =>
    Effect.gen(function* () {
      const result = yield* claimPreviewRecording(ThreadId.make("thread-1"), {
        id: "desktop-recording",
        tabId: "tab-1",
        path: "/desktop/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 6,
        createdAt: "2026-09-07T00:00:00.000Z",
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure._tag).toBe("PreviewAutomationRecordingDesktopUpdateRequiredError");
      expect(result.failure.message).toContain("Update the desktop app");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
