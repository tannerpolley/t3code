import { EnvironmentToolkit } from "./tools.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Sidebar from "../../../sidebarLayout.ts";
import { EMPTY_SIDEBAR_LAYOUT } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";

import { McpSchema, McpServer } from "effect/ai";

import * as Environment from "../../../environment/ServerEnvironment.ts";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");
const caller: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "provider:preferences",
  thread: {
    threadId,
    providerSessionId: "provider:preferences",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};
const layerEnvironment = Layer.mock(Environment.ServerEnvironment)({
  getDescriptor: Effect.succeed({
    environmentId,
    label: "Test",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0",
    capabilities: { repositoryIdentity: false },
  }),
});

const callTool = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name, arguments: args }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
      Effect.provideService(
        McpSchema.McpServerClient,
        McpSchema.McpServerClient.of({
          clientId: 1,
          protocolVersion: "2025-06-18",
          clientCapabilities: {},
          clientInfo: { name: "preferences", version: "1" },
          initializePayload: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "preferences", version: "1" },
          },
          getClient: Effect.die("unused"),
        }),
      ),
    );
  });
const layerMcpEnvironment = McpHttpServer.toolkitRegistration(
  EnvironmentToolkit,
  EnvironmentHandlers.layer,
).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
    }),
  ),
  Layer.provide(layerEnvironment),
  Layer.provide(
    Layer.mock(Sidebar.SidebarLayoutService)({
      get: Effect.succeed({
        revision: 0,
        legacyImportedAt: null,
        legacyImportId: null,
        layout: EMPTY_SIDEBAR_LAYOUT,
      }),
    }),
  ),
  Layer.provideMerge(Settings.layerTest()),
);

it.effect("updates preferences for a thread caller through the /mcp registration", () =>
  Effect.gen(function* () {
    const result = yield* callTool("t3_environment_preferences_update", {
      newWorktreesStartFromOrigin: true,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ newWorktreesStartFromOrigin: true });
  }).pipe(Effect.provide(layerMcpEnvironment)),
);

it.effect("edits local server hide rules against the latest list, keeping the owner's rules", () =>
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const serena = { kind: "process", processName: "serena" } as const;
    const syncthing = { kind: "process", processName: "syncthing" } as const;
    const port = { kind: "ports", from: 3773, to: 3773 } as const;
    yield* settings.updateSettings({ localServerHideRules: [serena] });
    // The owner adds a rule in Settings after the agent last read the list.
    yield* settings.updateSettings({ localServerHideRules: [serena, syncthing] });
    const added = yield* callTool("t3_environment_preferences_update", {
      addLocalServerHideRules: [port, { kind: "process", processName: "SERENA" }],
      removeLocalServerHideRules: [{ kind: "process", processName: "not-hidden" }],
    });
    expect(added.structuredContent).toMatchObject({
      localServerHideRules: [serena, syncthing, port],
    });
    yield* callTool("t3_environment_preferences_update", {
      removeLocalServerHideRules: [{ kind: "process", processName: "Serena" }],
    });
    const read = yield* callTool("t3_environment_read", {});
    expect(read.structuredContent).toMatchObject({
      preferences: { localServerHideRules: [syncthing, port] },
    });
  }).pipe(Effect.provide(layerMcpEnvironment)),
);
