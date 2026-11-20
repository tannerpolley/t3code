import {
  ProviderDriverKind,
  ThreadRoleInput,
  ServerSettings,
  ProviderInstanceId,
  type ModelRole,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { usageLimitSwitchTarget, usageLimitThreadRole } from "./usageLimitSwitchTarget.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const otherClaude = ProviderInstanceId.make("claudeOther");
const source: ModelSelection = {
  instanceId: codex,
  model: "sol",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "serviceTier", value: "default" },
  ],
};
const now = Date.parse("2026-10-13T12:00:00Z");
const provider = (
  id: ProviderInstanceId,
  driver: string,
  model: string,
  used?: number,
): ServerProvider => ({
  instanceId: id,
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  status: "ready",
  version: "test",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-13T12:00:00Z",
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  skills: [],
  slashCommands: [],
  ...(used === undefined
    ? {}
    : {
        usageLimits: {
          checkedAt: "2026-10-13T12:00:00Z",
          windows: [
            {
              id: "weekly",
              label: "Weekly",
              kind: "weekly",
              usedPercent: used,
              resetsAt: "2026-10-16T12:00:00Z",
              windowDurationMins: 10080,
            },
          ],
        },
      }),
});
const role = (
  id: string,
  selection: ModelSelection,
  alternative: ModelSelection,
  extra: Partial<ModelRole> = {},
): ModelRole => ({
  id,
  name: id,
  description: "",
  ...extra,
  targets: [
    {
      providerInstanceId: selection.instanceId,
      model: selection.model,
      ...(selection.options === undefined ? {} : { options: selection.options }),
    },
    {
      providerInstanceId: alternative.instanceId,
      model: alternative.model,
      ...(alternative.options === undefined ? {} : { options: alternative.options }),
    },
  ],
});
// A thread the user started in the main checkout: an Orchestrator unless it stores a role.
const topLevel = { branch: null, worktreePath: null, lineage: { relationshipToParent: null } };
const alternative: ModelSelection = {
  instanceId: claude,
  model: "opus",
  options: [{ id: "effort", value: "medium" }],
};

const decodeThreadRole = Schema.decodeUnknownSync(ThreadRoleInput);
const settingsWith = Schema.decodeSync(ServerSettings);

describe("usage-limit target selection", () => {
  it("switches a role-less top-level thread as an Orchestrator even when a Reviewer lists its model", () => {
    const settings = settingsWith({
      modelRoles: {
        orchestrator: { complex: { provider: "both" } },
        reviewer: { complex: { provider: "codex" } },
      },
      modelTiers: {
        1: { codex: { model: "sol" } },
        2: { claude: { model: "opus" }, codex: { model: "sol" } },
      },
    });
    const providers = [
      provider(codex, "codex", "sol"),
      provider(claude, "claudeAgent", "opus"),
      provider(otherClaude, "claudeAgent", "opus"),
    ];
    expect(
      usageLimitSwitchTarget(
        { ...topLevel, modelSelection: source },
        settings,
        providers,
        new Set([codex, claude, otherClaude]),
        now,
      ),
    ).toEqual(alternative);
  });

  it("uses the thread's effective role and matches Implementor levels within it", () => {
    const orchestrator = role("orchestrator", source, alternative, { role: "orchestrator" });
    const routine = role(
      "implementor-routine",
      { ...source, options: [{ id: "reasoningEffort", value: "medium" }] },
      alternative,
      { role: "implementor", level: "routine" },
    );
    const complex = role(
      "implementor-complex",
      { ...source, options: [{ id: "reasoningEffort", value: "high" }] },
      alternative,
      {
        role: "implementor",
        level: "complex",
      },
    );
    const roles = [orchestrator, complex, routine];
    expect(
      usageLimitThreadRole(
        { ...topLevel, modelSelection: { ...source, options: source.options!.toReversed() } },
        roles,
      ),
    ).toBe(orchestrator);
    expect(
      usageLimitThreadRole({ ...topLevel, role: "implementor", modelSelection: source }, roles),
    ).toBe(complex);
    expect(
      usageLimitThreadRole(
        {
          ...topLevel,
          role: "implementor",
          modelSelection: { ...source, options: [{ id: "reasoningEffort", value: "medium" }] },
        },
        roles,
      ),
    ).toBe(routine);
    expect(
      usageLimitThreadRole(
        { ...topLevel, role: "implementor", modelSelection: { ...source, model: "custom" } },
        roles,
      ),
    ).toBe(complex);
    expect(
      usageLimitThreadRole({ ...topLevel, role: "reviewer", modelSelection: source }, roles),
    ).toBeUndefined();
  });

  it("prefers a matching complex effort over a routine default effort on the same tier", () => {
    const settings = settingsWith({
      modelRoles: {
        implementor: {
          routine: { tier: 2, provider: "both", effort: "default" },
          complex: { tier: 2, provider: "codex", effort: "high" },
        },
      },
      modelTiers: { 2: { claude: { model: "opus" }, codex: { model: "sol" } } },
    });
    expect(
      usageLimitSwitchTarget(
        { ...topLevel, role: "implementor", modelSelection: source },
        settings,
        [provider(codex, "codex", "sol", 100), provider(claude, "claudeAgent", "opus")],
        new Set([codex, claude]),
        now,
      ),
    ).toBeNull();
  });

  it("recovers an old Checker thread using the matching Reviewer routine target", () => {
    const settings = settingsWith({
      modelRoles: { reviewer: { routine: { provider: "both", effort: "medium" } } },
      modelTiers: { 2: { codex: { model: "sol" }, claude: { model: "opus" } } },
    });
    const role = decodeThreadRole("checker");
    expect(
      usageLimitSwitchTarget(
        {
          ...topLevel,
          role,
          modelSelection: { ...source, options: [{ id: "reasoningEffort", value: "medium" }] },
        },
        settings,
        [provider(codex, "codex", "sol", 100), provider(claude, "claudeAgent", "opus")],
        new Set([codex, claude]),
        now,
      ),
    ).toEqual(alternative);
  });

  it("uses existing weekly-headroom ranking across alternatives and preserves provider-specific effort", () => {
    const settings = settingsWith({
      modelRoles: { reviewer: { complex: { provider: "codex" } } },
      usageLimitFallbackModels: [
        alternative,
        { instanceId: otherClaude, model: "opus", options: [{ id: "effort", value: "low" }] },
      ],
    });
    const providers = [
      provider(codex, "codex", "sol"),
      provider(claude, "claudeAgent", "opus", 60),
      provider(otherClaude, "claudeAgent", "opus", 20),
    ];
    const result = usageLimitSwitchTarget(
      { ...topLevel, role: "reviewer", modelSelection: source },
      settings,
      providers,
      new Set([codex, claude, otherClaude]),
      now,
    );
    expect(result).toEqual({
      instanceId: otherClaude,
      model: "opus",
      options: [{ id: "effort", value: "low" }],
    });
  });

  it("keeps the approved first recovery target ahead of a higher-headroom fallback", () => {
    const codexAlt = ProviderInstanceId.make("codex-alt");
    const primary = { instanceId: codex, model: "sol" };
    const settings = settingsWith({
      modelRoles: { orchestrator: { complex: { provider: "claude" } } },
      providerCreditsApproved: { codex: true },
      usageLimitFallbackModels: [primary, { ...primary, instanceId: codexAlt }],
    });
    expect(
      usageLimitSwitchTarget(
        { ...topLevel, modelSelection: alternative },
        settings,
        [
          provider(claude, "claudeAgent", "opus", 100),
          provider(codex, "codex", "sol", 93),
          provider(codexAlt, "codex", "sol", 20),
        ],
        new Set([claude, codex, codexAlt]),
        now,
      ),
    ).toEqual(primary);
  });

  it.each(["exhausted", "unauthenticated", "invalid-effort", "missing-adapter", "disabled"])(
    "does not switch to an %s fallback",
    (reason) => {
      const target: ServerProvider = {
        ...provider(claude, "claudeAgent", "opus", reason === "exhausted" ? 100 : 10),
        ...(reason === "unauthenticated" ? { auth: { status: "unauthenticated" as const } } : {}),
        ...(reason === "disabled" ? { enabled: false } : {}),
        ...(reason === "invalid-effort"
          ? {
              models: [
                {
                  slug: "opus",
                  name: "opus",
                  isCustom: false,
                  capabilities: {
                    optionDescriptors: [
                      {
                        id: "effort",
                        label: "Effort",
                        type: "select" as const,
                        options: [{ id: "high", label: "High" }],
                      },
                    ],
                  },
                },
              ],
            }
          : {}),
      };
      const result = usageLimitSwitchTarget(
        { ...topLevel, modelSelection: source },
        settingsWith({
          modelRoles: { orchestrator: { complex: { provider: "codex" } } },
          usageLimitFallbackModels: [alternative],
        }),
        [provider(codex, "codex", "sol"), target],
        new Set(reason === "missing-adapter" ? [codex] : [codex, claude]),
        now,
      );
      expect(result).toBeNull();
    },
  );
});

it("uses fallbacks when a role has no available other-provider choice and excludes only targets", () => {
  const settings = settingsWith({
    modelRoles: { orchestrator: { complex: { provider: "codex" } } },
    usageLimitFallbackModels: [alternative],
  });
  const providers = [provider(codex, "codex", "sol"), provider(claude, "claudeAgent", "opus")];
  expect(
    usageLimitSwitchTarget(
      { ...topLevel, role: "orchestrator", modelSelection: source },
      settings,
      providers,
      new Set([codex, claude]),
      now,
    ),
  ).toEqual(alternative);
  expect(
    usageLimitSwitchTarget(
      { ...topLevel, role: "orchestrator", modelSelection: source },
      settings,
      providers,
      new Set([codex, claude]),
      now,
      new Set([codex]),
    ),
  ).toEqual(alternative);
});
