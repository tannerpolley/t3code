import { assert, it } from "@effect/vitest";

import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  applyCodexInstalledPlugins,
  applyPreferredCodexDefaultModel,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

const codexPlugin = (
  name: string,
  marketplace: string,
  state: { installed: boolean; enabled: boolean },
): CodexSchema.V2PluginInstalledResponse["marketplaces"][number]["plugins"][number] => ({
  id: `${name}@${marketplace}`,
  name,
  installed: state.installed,
  enabled: state.enabled,
  authPolicy: "ON_USE",
  installPolicy: "AVAILABLE",
  source: { type: "local", path: `/plugins/${marketplace}/${name}` },
});

it("tags plugin skills and lists only enabled plugins", () => {
  const cache = "/home/me/.codex/plugins/cache";
  const result = applyCodexInstalledPlugins(
    [
      {
        name: "review",
        path: "/home/me/.codex/skills/review/SKILL.md",
        enabled: true,
        scope: "user",
      },
      {
        name: "cse:build",
        path: `${cache}/cse/cse/1/skills/build/SKILL.md`,
        enabled: true,
        scope: "user",
      },
      {
        name: "cse:plot",
        path: `${cache}/cse/cse/1/skills/plot/SKILL.md`,
        enabled: false,
        scope: "user",
      },
      {
        name: "browser:open",
        path: `${cache}/openai-bundled/browser/2/skills/open/SKILL.md`,
        enabled: true,
        scope: "user",
      },
      {
        name: "github:fix-ci",
        path: `${cache}/curated/github/1/skills/fix-ci/SKILL.md`,
        enabled: true,
        scope: "user",
      },
    ],
    {
      marketplaces: [
        {
          name: "personal",
          plugins: [codexPlugin("cse", "personal", { installed: true, enabled: false })],
        },
        { name: "cse", plugins: [codexPlugin("cse", "cse", { installed: true, enabled: true })] },
        {
          name: "openai-bundled",
          plugins: [
            codexPlugin("browser", "openai-bundled", { installed: true, enabled: true }),
            codexPlugin("visualize", "openai-bundled", { installed: false, enabled: false }),
          ],
        },
        {
          name: "curated",
          plugins: [codexPlugin("github", "curated", { installed: true, enabled: false })],
        },
      ],
    },
  );

  assert.deepStrictEqual(
    result.skills.map((skill) => [skill.name, skill.scope, skill.pluginName, skill.enabled]),
    [
      ["review", "user", undefined, true],
      // A same-named disabled plugin in another marketplace does not claim
      // these: the install path names the enabled one.
      ["cse:build", "plugin", "cse", true],
      ["cse:plot", "plugin", "cse", false],
      ["browser:open", "plugin", "browser", true],
    ],
  );
  assert.deepStrictEqual(result.plugins, [
    { name: "cse", marketplace: "cse", skillCount: 2 },
    { name: "browser", marketplace: "openai-bundled", skillCount: 1, requiresDesktopApp: true },
  ]);
});
