import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId, ServerSettings } from "@t3tools/contracts";

import { assert, it } from "@effect/vitest";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Layer from "effect/Layer";

import * as Schema from "effect/Schema";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";

import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";

import * as ServerSettingsModule from "./serverSettings.ts";
import { EnvironmentToolkit } from "./mcp/toolkits/environment/tools.ts";

const decodeAgentPreferences = Schema.decodeUnknownEffect(
  EnvironmentToolkit.tools.t3_environment_preferences_update.parametersSchema,
);
const decodeServerSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));

const layerServerSettings = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );

it.effect("agents cannot change user-only policies through environment preferences", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeAgentPreferences({
      issueUpkeepRequiresApproval: false,
      dontAskMode: true,
      enableProviderUpdateChecks: false,
    });
    assert.deepEqual(decoded, { enableProviderUpdateChecks: false });
  }),
);

it.effect("test settings layer reads and updates dont-ask mode from its current state", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsModule.ServerSettingsService;
    const initial = DEFAULT_SERVER_SETTINGS.dontAskMode;

    assert.equal(yield* settings.getDontAskMode, initial);
    yield* settings.updateSettingsWith((current) => ({ dontAskMode: !current.dontAskMode }));
    assert.equal(yield* settings.getDontAskMode, !initial);
    yield* settings.updateSettingsWith((current) => ({ dontAskMode: !current.dontAskMode }));
    assert.equal(yield* settings.getDontAskMode, initial);
  }).pipe(Effect.provide(ServerSettingsModule.layerTest())),
);

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("issue upkeep approval defaults off and persists the user's choice", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      assert.isFalse((yield* service.getSettings).issueUpkeepRequiresApproval);
      assert.isTrue(
        (yield* service.updateSettings({ issueUpkeepRequiresApproval: true }))
          .issueUpkeepRequiresApproval,
      );
      const saved = yield* decodeServerSettingsJson(yield* fs.readFileString(config.settingsPath));
      assert.isTrue(saved.issueUpkeepRequiresApproval);
      assert.isFalse(
        (yield* service.updateSettings({ issueUpkeepRequiresApproval: false }))
          .issueUpkeepRequiresApproval,
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("loads a saved agentBrowserTabLimits off", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* fs.writeFileString(config.settingsPath, `{ "agentBrowserTabLimits": false }`);

      assert.isFalse((yield* service.getSettings).agentBrowserTabLimits);
    }).pipe(Effect.provide(layerServerSettings())),
  );
});

it.effect.each([
  { saved: { autoResumeLimitedThreads: true }, mode: "wait", resume: true, snooze: false },
  { saved: { snoozeLimitedThreads: true }, mode: "wait", resume: false, snooze: true },
  { saved: {}, mode: "off", resume: false, snooze: false },
  {
    saved: { usageLimitRecovery: "unknown", snoozeLimitedThreads: true },
    mode: "wait",
    resume: false,
    snooze: true,
  },
])("migrates saved limit recovery tolerantly: %j", (testCase) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const service = yield* ServerSettingsModule.ServerSettingsService;
    yield* fs.writeFileString(config.settingsPath, JSON.stringify(testCase.saved));
    const settings = yield* service.getSettings;
    assert.equal(settings.usageLimitRecovery, testCase.mode);
    assert.equal(settings.autoResumeLimitedThreads, testCase.resume);
    assert.equal(settings.snoozeLimitedThreads, testCase.snooze);
    const changed = yield* service.updateSettings({
      usageLimitRecovery: "switch",
      usageLimitFallbackModels: [
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "high" }],
        },
      ],
    });
    assert.isFalse(changed.autoResumeLimitedThreads);
    assert.isFalse(changed.snoozeLimitedThreads);
    assert.equal(changed.usageLimitFallbackModels[0]?.options?.[0]?.value, "high");
    assert.equal((yield* service.getSettings).usageLimitRecovery, "switch");
    const off = yield* service.updateSettings({
      usageLimitRecovery: "off",
      autoResumeLimitedThreads: true,
    });
    assert.equal(off.usageLimitRecovery, "off");
    assert.isFalse(off.autoResumeLimitedThreads);
  }).pipe(Effect.provide(layerServerSettings().pipe(Layer.provideMerge(NodeServices.layer)))),
);
