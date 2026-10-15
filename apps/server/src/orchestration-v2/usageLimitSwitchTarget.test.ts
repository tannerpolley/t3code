import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelRole,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
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

describe("usage-limit target selection", () => {
  it("switches a role-less top-level thread as an Orchestrator even when a Reviewer lists its model", () => {
    const reviewerTarget: ModelSelection = { instanceId: otherClaude, model: "opus" };
    const settings = {
      modelRoles: [
        role("reviewer", source, reviewerTarget, { role: "reviewer" }),
        role("orchestrator", source, alternative, { role: "orchestrator" }),
      ],
      usageLimitFallbackModels: [],
    };
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

  it("uses the thread's effective role and matches Implementor profiles within it", () => {
    const orchestrator = role("orchestrator", source, alternative, { role: "orchestrator" });
    const fast = role(
      "implementor-fast",
      { ...source, options: [{ id: "reasoningEffort", value: "medium" }] },
      alternative,
      { role: "implementor", profile: "fast" },
    );
    const thorough = role("implementor-thorough", source, alternative, {
      role: "implementor",
      profile: "thorough",
    });
    const roles = [orchestrator, fast, thorough];
    expect(
      usageLimitThreadRole(
        { ...topLevel, modelSelection: { ...source, options: source.options!.toReversed() } },
        roles,
      ),
    ).toBe(orchestrator);
    expect(
      usageLimitThreadRole({ ...topLevel, role: "implementor", modelSelection: source }, roles),
    ).toBe(thorough);
    expect(
      usageLimitThreadRole(
        { ...topLevel, role: "implementor", modelSelection: { ...source, model: "custom" } },
        roles,
      ),
    ).toBe(fast);
    expect(
      usageLimitThreadRole({ ...topLevel, role: "reviewer", modelSelection: source }, roles),
    ).toBeUndefined();
  });

  it("uses existing weekly-headroom ranking across alternatives and preserves provider-specific effort", () => {
    const base = role("reviewer", source, alternative, { role: "reviewer" });
    const ranked: ModelRole = {
      ...base,
      targets: [
        ...base.targets,
        {
          providerInstanceId: otherClaude,
          model: "opus",
          options: [{ id: "effort", value: "low" }],
        },
      ],
    };
    const providers = [
      provider(codex, "codex", "sol"),
      provider(claude, "claudeAgent", "opus", 80),
      provider(otherClaude, "claudeAgent", "opus", 20),
    ];
    const result = usageLimitSwitchTarget(
      { ...topLevel, role: "reviewer", modelSelection: source },
      { modelRoles: [ranked], usageLimitFallbackModels: [] },
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
        { modelRoles: [], usageLimitFallbackModels: [alternative] },
        [provider(codex, "codex", "sol"), target],
        new Set(reason === "missing-adapter" ? [codex] : [codex, claude]),
        now,
      );
      expect(result).toBeNull();
    },
  );
});

it("uses fallbacks when a role has no available other-provider choice and excludes only targets", () => {
  const settings = {
    modelRoles: [role("orchestrator", source, source, { role: "orchestrator" })],
    usageLimitFallbackModels: [alternative],
  };
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
