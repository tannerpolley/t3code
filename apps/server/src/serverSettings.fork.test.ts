import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  resolveModelRoles,
  ServerSettings,
} from "@t3tools/contracts";

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
    Layer.provide(ManagedPolicy.layerTest()),
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
      providerCreditsApproved: { codex: true },
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

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("server settings", (it) => {
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
  }).pipe(
    Effect.provide(
      layerServerSettings().pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect.each(["codex", "mixed"])(
  "migrates the saved %s worker switch and choices to per-role tiers",
  (workerProvider) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const rows = [
        ["orchestrator", 2, "claude", "default", "claude-opus-5-5", null],
        ["implementor-fast", 3, "codex", "xhigh", "gpt-6.1-terra", ["claude-sonnet-5-5", "high"]],
        ["implementor-thorough", 2, "codex", "high", "gpt-6.2-sol", ["claude-opus-5-5", "medium"]],
        ["checker", 2, "codex", "high", "gpt-6.2-sol", ["claude-opus-5-5", "xhigh"]],
        ["reviewer", 1, "codex", "medium", "gpt-6.2-astra", ["claude-fable-5-2", "high"]],
        ["investigator", 4, "codex", "xhigh", "gpt-6-luna", ["claude-haiku-5-5", "xhigh"]],
        ["designer", 1, "claude", "high", "claude-fable-5-2", null],
        ["writer", 1, "claude", "high", "claude-fable-5-2", null],
      ] as const;
      const modelRoles = rows.map(([id, , provider, effort, model, alternate]) => ({
        id,
        name: id,
        description: `Saved ${id} description`,
        targets: [
          ...(alternate === null
            ? []
            : [
                {
                  providerInstanceId: "claudeAgent",
                  model: alternate[0],
                  options: [{ id: "effort", value: alternate[1] }],
                },
              ]),
          {
            providerInstanceId: ProviderInstanceId.make(
              provider === "claude" ? "claudeAgent" : "codex",
            ),
            model,
            ...(effort === "default"
              ? {}
              : {
                  options:
                    provider === "claude"
                      ? [{ id: "effort", value: effort }]
                      : [
                          { id: "reasoningEffort", value: effort },
                          { id: "serviceTier", value: "default" },
                          { id: "cyberAccessProgram", value: "standard" },
                        ],
                }),
          },
        ],
      }));
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ modelRoles, workerProvider }),
      );
      const migrated = yield* service.getSettings;
      if (workerProvider === "mixed") {
        assert.deepEqual(migrated.modelRoles["implementor-fast"], {
          description: "Saved implementor-fast description",
          tier: 3,
          provider: "both",
          effort: "high",
        });
        return;
      }
      const resolved = resolveModelRoles(migrated);
      for (const [id, tier, provider, effort, model] of rows) {
        assert.deepEqual(migrated.modelRoles[id], {
          description: `Saved ${id} description`,
          tier,
          provider,
          effort,
        });
        assert.deepEqual(resolved.find((role) => role.id === id)?.targets, [
          {
            providerInstanceId: ProviderInstanceId.make(
              provider === "claude" ? "claudeAgent" : "codex",
            ),
            model,
            ...(effort === "default"
              ? {}
              : {
                  options: [
                    { id: provider === "claude" ? "effort" : "reasoningEffort", value: effort },
                  ],
                }),
          },
        ]);
      }

      yield* Effect.all(
        [
          service.updateSettings({ modelRoles: { reviewer: { provider: "both" } } }),
          service.updateSettings({ modelRoles: { writer: { effort: "max" } } }),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* fs.readFileString(config.settingsPath);
      assert.notProperty(JSON.parse(persisted), "workerProvider");
      const patched = yield* decodeServerSettingsJson(persisted);
      assert.equal(patched.modelRoles.reviewer.provider, "both");
      assert.equal(patched.modelRoles.writer.effort, "max");
      assert.equal(patched.modelRoles.reviewer.description, "Saved reviewer description");
    }).pipe(
      Effect.provide(
        layerServerSettings().pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
);
