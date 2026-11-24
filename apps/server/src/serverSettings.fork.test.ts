import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  type ManagedPolicyDocument,
  ProjectId,
  ProviderInstanceId,
  resolveModelRoles,
  resolveModelRoleName,
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

const layerServerSettings = (policy?: ManagedPolicyDocument) =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ManagedPolicy.layerTest(policy)),
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

  it.effect.each([
    { saved: null, expected: null },
    { saved: 260_000, expected: 8 },
  ])("migrates saved orchestrator handoff tokens ($saved)", ({ saved, expected }) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          orchestratorHandoffTokens: saved,
          dontAskMode: true,
          projectSettingsOverrides: {
            off: { orchestratorHandoffTokens: null },
            on: { orchestratorHandoffTokens: 250_000, responseStreamingMode: "paragraph" },
            inherit: { sidebarAutoSettleOnMerge: true },
            current: { orchestratorHandoffTokens: null, orchestratorHandoffCompactions: 12 },
          },
        }),
      );
      const settings = yield* service.getSettings;
      assert.isTrue(settings.dontAskMode);
      assert.equal(settings.orchestratorHandoffCompactions, expected);
      assert.deepEqual(settings.projectSettingsOverrides, {
        [ProjectId.make("off")]: { orchestratorHandoffCompactions: null },
        [ProjectId.make("on")]: {
          orchestratorHandoffCompactions: 8,
          responseStreamingMode: "paragraph",
        },
        [ProjectId.make("inherit")]: { sidebarAutoSettleOnMerge: true },
        [ProjectId.make("current")]: { orchestratorHandoffCompactions: 12 },
      });

      yield* service.updateSettings({ dontAskMode: false });
      const persisted = yield* fs.readFileString(config.settingsPath);
      assert.notInclude(persisted, "orchestratorHandoffTokens");
      assert.equal(
        (yield* decodeServerSettingsJson(persisted)).orchestratorHandoffCompactions,
        expected,
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

  it.effect("keeps migrated role choices through an unrelated save under a managed default", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ modelRoles: { designer: { effort: "high", provider: "claude" } } }),
      );

      const settings = yield* service.getSettings;
      assert.equal(settings.modelRoles.designer.complex.effort, "high");
      assert.equal(settings.modelRoles.reviewer.routine.provider, "claude");
      yield* service.updateSettings({ dontAskMode: !settings.dontAskMode });

      const stored = JSON.parse(yield* fs.readFileString(config.settingsPath));
      assert.deepEqual(stored.modelRoles.designer.complex, { effort: "high", provider: "claude" });
      assert.notProperty(stored.modelRoles, "reviewer");
    }).pipe(
      Effect.provide(
        layerServerSettings({
          schemaVersion: 1,
          organization: "Example Corp",
          settings: {
            "modelRoles.designer.complex.provider": { value: "claude", locked: false },
            "modelRoles.reviewer.routine.provider": { value: "claude", locked: false },
          },
        }),
      ),
    ),
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

const legacyWorkerSettings = [
  { label: "Codex", workerProvider: "codex", sparse: false },
  { label: "Mixed", workerProvider: "mixed", sparse: false },
  { label: "Codex with omitted roles", workerProvider: "codex", sparse: true },
] as const;

it.effect.each(legacyWorkerSettings)(
  "migrates the $label worker switch to per-role tiers",
  ({ workerProvider, sparse }) =>
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
        JSON.stringify(sparse ? { workerProvider } : { modelRoles, workerProvider }),
      );
      const migrated = yield* service.getSettings;
      if (sparse) {
        assert.equal(migrated.modelRoles.implementor.routine.provider, "codex");
        assert.equal(migrated.modelRoles.orchestrator.complex.provider, "claude");
        assert.equal(migrated.modelRoles.writer.complex.provider, "claude");
        return;
      }
      if (workerProvider === "mixed") {
        assert.deepEqual(migrated.modelRoles.implementor.routine, {
          description: "Saved implementor-fast description",
          tier: 3,
          provider: "both",
          effort: "high",
        });
        return;
      }
      const resolved = resolveModelRoles(migrated);
      for (const [id, tier, provider, effort, model] of rows) {
        const [role, level] = resolveModelRoleName(id)!;
        assert.deepEqual(migrated.modelRoles[role][level], {
          description: `Saved ${id} description`,
          tier,
          provider,
          effort,
        });
        assert.deepEqual(resolved.find((entry) => entry.id === `${role}-${level}`)?.targets, [
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
          service.updateSettings({ modelRoles: { reviewer: { complex: { provider: "both" } } } }),
          service.updateSettings({ modelRoles: { writer: { complex: { effort: "max" } } } }),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* fs.readFileString(config.settingsPath);
      assert.notProperty(JSON.parse(persisted), "workerProvider");
      const patched = yield* decodeServerSettingsJson(persisted);
      assert.equal(patched.modelRoles.reviewer.complex.provider, "both");
      assert.equal(patched.modelRoles.writer.complex.effort, "max");
      assert.equal(patched.modelRoles.reviewer.complex.description, "Saved reviewer description");
    }).pipe(
      Effect.provide(
        layerServerSettings().pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
);

it.effect.each([
  [{ designer: {} }, "both", "codex", { tier: 4, provider: "codex", effort: "max" }],
  [
    { sprinter: { provider: "claude" } },
    "claude",
    "codex",
    { tier: 4, provider: "codex", effort: "max" },
  ],
  [
    { designer: {}, reviewer: { routine: { provider: "claude" } } },
    "both",
    "claude",
    { tier: 2, provider: "claude", effort: "medium" },
  ],
] as const)(
  "loads a partial modelRoles file (%j)",
  ([modelRoles, implementorProvider, reviewerProvider, designerRoutine]) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* fs.writeFileString(config.settingsPath, JSON.stringify({ modelRoles }));
      const { modelRoles: migrated } = yield* service.getSettings;
      assert.equal(migrated.reviewer.routine.provider, reviewerProvider);
      assert.deepInclude(migrated.designer.routine, designerRoutine);
      assert.equal(migrated.implementor.routine.provider, implementorProvider);
    }).pipe(
      Effect.provide(
        layerServerSettings().pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
);

it.effect("fills old defaults before folding the owner's sparse role settings", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const service = yield* ServerSettingsModule.ServerSettingsService;
    yield* fs.writeFileString(
      config.settingsPath,
      JSON.stringify({
        modelRoles: {
          designer: { effort: "high" },
          "implementor-fast": { provider: "codex", effort: "xhigh" },
          investigator: { effort: "xhigh", description: "Saved investigator description" },
          reviewer: { effort: "medium" },
        },
      }),
    );
    const { modelRoles } = yield* service.getSettings;
    assert.deepInclude(modelRoles.designer.routine, {
      tier: 4,
      provider: "codex",
      effort: "xhigh",
      description: "Saved investigator description",
    });
    assert.deepInclude(modelRoles.designer.complex, {
      tier: 1,
      provider: "claude",
      effort: "high",
    });
    assert.deepInclude(modelRoles.implementor.routine, {
      tier: 3,
      provider: "codex",
      effort: "xhigh",
    });
    assert.deepInclude(modelRoles.reviewer.routine, { tier: 2, provider: "codex", effort: "high" });
    assert.deepInclude(modelRoles.reviewer.complex, {
      tier: 1,
      provider: "codex",
      effort: "medium",
    });
    const patched = yield* service.updateSettings({
      modelRoles: { designer: { routine: { tier: 3 } } },
    });
    const persisted = yield* fs.readFileString(config.settingsPath);
    assert.deepEqual((yield* decodeServerSettingsJson(persisted)).modelRoles, patched.modelRoles);
    assert.deepEqual(patched.modelRoles.designer, {
      ...modelRoles.designer,
      routine: { ...modelRoles.designer.routine, tier: 3 },
    });
  }).pipe(
    Effect.provide(
      layerServerSettings().pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
