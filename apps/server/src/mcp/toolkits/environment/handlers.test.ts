import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as IssueWorkStore from "../../../issues/IssueWorkStore.ts";
import * as Sidebar from "../../../sidebarLayout.ts";
import { EMPTY_SIDEBAR_LAYOUT } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

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
const layerMcpEnvironment = McpHttpServer.layerEnvironmentToolkit.pipe(
  Layer.provide(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
    }),
  ),
  Layer.provide(
    Layer.mock(IssueWorkStore.IssueWorkStore)({
      isRepositoryOrchestrator: () => Effect.succeed(false),
    }),
  ),
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

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      Layer.mock(Sidebar.SidebarLayoutService)({
        get: Effect.succeed({
          revision: 0,
          legacyImportedAt: null,
          legacyImportId: null,
          layout: EMPTY_SIDEBAR_LAYOUT,
        }),
      }),
      ThreadCommandExecutor.layer,
      Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThreadShell: () => Ref.get(caller) }),
      Layer.mock(IssueWorkStore.IssueWorkStore)({
        isRepositoryOrchestrator: () => Effect.succeed(false),
      }),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
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
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettingsWith: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* executor
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const update = yield* toolkit
        .handle("t3_environment_preferences_update", { newWorktreesStartFromOrigin: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(checked);
      yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const result = yield* Fiber.join(update);
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(updates)).toBe(0);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);
