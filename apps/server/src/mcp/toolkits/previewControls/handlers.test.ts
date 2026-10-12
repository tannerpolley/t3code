import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as Preview from "../../../preview/Manager.ts";
import * as ProjectFaviconResolver from "../../../project/ProjectFaviconResolver.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewControlsHandlers from "./handlers.ts";
import { PreviewControlsToolkit } from "./tools.ts";

it.effect.each([
  { name: "project opt-in", globalAccess: false, projectAccess: true },
  { name: "project opt-out", globalAccess: true, projectAccess: false },
])("list and close respect the credential for a $name", ({ globalAccess, projectAccess }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const projectId = ProjectId.make("preview-controls-project");
      const threadId = ThreadId.make("preview-controls-thread");
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        enableAgentBrowserAccess: globalAccess,
        projectSettingsOverrides: {
          [projectId]: { enableAgentBrowserAccess: projectAccess },
        },
      };
      const effective = resolveProjectSettings(settings, projectId).settings;
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("preview-controls-environment"),
        requestNamespace: "preview-controls-provider-session",
        thread: {
          threadId,
          providerSessionId: "preview-controls-provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(effective.enableAgentBrowserAccess ? ["preview"] : []),
        issuedAt: 0,
      };
      const configLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-preview-controls-",
      }).pipe(Layer.provide(NodeServices.layer));
      const manager = yield* Preview.make.pipe(
        Effect.provide(Layer.mergeAll(configLayer, NodeCrypto.layer, ServerSettings.layerTest())),
      );
      const tab = yield* manager.open({ threadId, url: "http://localhost:3000" });
      const layerDependencies = Layer.mergeAll(
        // The broker reads the agent tab limit and can sign file URLs; neither runs here.
        PreviewAutomationBroker.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              configLayer,
              NodeServices.layer,
              ServerSettings.layerTest(),
              Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
              Layer.mock(ServerSecretStore.ServerSecretStore)({}),
              Layer.mock(WorkspacePaths.WorkspacePaths)({}),
            ),
          ),
        ),
        Layer.succeed(Preview.PreviewManager, manager),
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(settings),
        }),
      );
      const toolkit = yield* PreviewControlsToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(PreviewControlsHandlers.layer).pipe(
            Layer.provide(layerDependencies),
          ),
        ),
      );
      const listed = yield* toolkit
        .handle("t3_preview_list", {})
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
      const closed = yield* toolkit
        .handle("t3_preview_close", { tabId: tab.tabId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
      if (projectAccess) {
        expect(listed.at(-1)?.result).toMatchObject({ sessions: [tab], nextCursor: null });
        expect(closed.at(-1)?.result).toEqual({});
        expect((yield* manager.list({ threadId })).sessions).toEqual([]);
      } else {
        for (const result of [listed, closed]) {
          expect(result.at(-1)?.result).toMatchObject({
            _tag: "PreviewAutomationUnavailableError",
            capability: "preview",
            threadId,
          });
        }
        expect((yield* manager.list({ threadId })).sessions).toEqual([tab]);
      }
    }),
  ),
);
