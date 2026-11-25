import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  buildExplicitProviderOptionSelectionsFromDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  DEFAULT_VARIANT_CHOICE_ID,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  readCustomModelEntries,
  modelSelectionsEqual,
  pickModelSelection,
  resolveCodexSpeed,
  withImplicitFastModeDefault,
} from "./model.ts";

const fastDescriptor = {
  currentValue: "priority",
  options: [
    { id: "default", label: "Normal", isDefault: true },
    { id: "priority", label: "Fast" },
  ],
};

it.each<{
  name: string;
  input: Parameters<typeof resolveCodexSpeed>[0];
  expected: ReturnType<typeof resolveCodexSpeed>;
}>([
  {
    name: "bare custom slug cannot borrow another model's Ultra fast",
    input: { defaultSpeed: "ultrafast" },
    expected: { tier: "default", speed: "standard" },
  },
  {
    name: "custom model with a declared Ultra fast tier",
    input: {
      defaultSpeed: "ultrafast",
      descriptor: { options: [{ id: "ultrafast", label: "Ultra fast" }] },
    },
    expected: { tier: "ultrafast", speed: "ultrafast" },
  },
  {
    name: "leaves the tier to Codex when T3 is unset, even with a Fast catalog default",
    input: { descriptor: fastDescriptor },
    expected: { tier: undefined, speed: undefined },
  },
  {
    name: "advertised model with no controls still has Normal speed",
    input: { threadTier: "ultrafast", defaultSpeed: "ultrafast" },
    expected: { tier: "default", speed: "standard" },
  },
  {
    name: "Normal thread choice outranks the role and environment",
    input: {
      descriptor: fastDescriptor,
      threadTier: "default",
      roleTier: "fast",
      defaultSpeed: "ultrafast",
    },
    expected: { tier: "default", speed: "standard" },
  },
  {
    name: "clearing a thread choice restores its Fast role over the environment",
    input: {
      descriptor: fastDescriptor,
      roleTier: "fast",
      defaultSpeed: "normal",
    },
    expected: { tier: "priority", speed: "fast" },
  },
  {
    name: "Ultra fast falls back to Fast on the model",
    input: { descriptor: fastDescriptor, defaultSpeed: "ultrafast" },
    expected: { tier: "priority", speed: "fast" },
  },
  {
    name: "an explicit Ultra fast choice falls back to Fast, not to lower settings",
    input: {
      descriptor: fastDescriptor,
      threadTier: "ultrafast",
      roleTier: "default",
      defaultSpeed: "normal",
    },
    expected: { tier: "priority", speed: "fast" },
  },
  {
    name: "recorded usage remains Ultra fast across catalog and settings changes",
    input: { descriptor: fastDescriptor, defaultSpeed: "normal", recordedTier: "ultrafast" },
    expected: { tier: "ultrafast", speed: "ultrafast" },
  },
])("resolves effective Codex speed: $name", ({ input, expected }) => {
  expect(resolveCodexSpeed(input)).toEqual(expected);
});

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

describe("descriptor helpers", () => {
  it("builds dispatch options only from explicit selections", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [{ id: "fastMode", value: true }],
    });

    expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, undefined)).toBe(
      undefined,
    );
    expect(
      buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, [
        { id: "fastMode", value: true },
      ]),
    ).toEqual([{ id: "fastMode", value: true }]);
  });

  it("dispatches an old Ultracode effort as Extra High with the Ultracode toggle", () => {
    const legacy = [{ id: "effort", value: "ultracode" }];
    const descriptors = getProviderOptionDescriptors({
      caps: createModelCapabilities({
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "high", label: "High", isDefault: true },
              { id: "xhigh", label: "Extra High" },
            ],
          },
          { id: "ultracode", label: "Ultracode", type: "boolean" },
        ],
      }),
      selections: legacy,
    });

    expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, legacy)).toEqual([
      { id: "effort", value: "xhigh" },
      { id: "ultracode", value: true },
    ]);
  });

  it("compares complete model selections independent of option ordering", () => {
    const left = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
    const reordered = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "high" },
    ]);

    expect(modelSelectionsEqual(left, reordered)).toBe(true);
    expect(
      modelSelectionsEqual(left, {
        ...reordered,
        options: [
          { id: "fastMode", value: true },
          { id: "reasoningEffort", value: "medium" },
        ],
      }),
    ).toBe(false);
    expect(modelSelectionsEqual(left, { ...reordered, model: "gpt-5.5" })).toBe(false);
  });

  it("keeps the options when the current model is picked again", () => {
    const codex = ProviderInstanceId.make("codex");
    const current = createModelSelection(codex, "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
    ]);

    expect(pickModelSelection(current, codex, "gpt-5.4")).toBe(current);
    expect(pickModelSelection(current, codex, "gpt-5.5")).toEqual({
      instanceId: "codex",
      model: "gpt-5.5",
    });
    expect(pickModelSelection(current, ProviderInstanceId.make("codex_work"), "gpt-5.4")).toEqual({
      instanceId: "codex_work",
      model: "gpt-5.4",
    });
    expect(pickModelSelection(null, codex, "gpt-5.4")).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
    });
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("keeps slash commands intact when ultrathink is selected", () => {
    expect(applyClaudePromptEffortPrefix("/compact", "ultrathink")).toBe("/compact");
    expect(applyClaudePromptEffortPrefix(" /compact keep recent errors ", "ultrathink")).toBe(
      "/compact keep recent errors",
    );
    expect(applyClaudePromptEffortPrefix(" /review src/model.ts ", "ultrathink")).toBe(
      "/review src/model.ts",
    );
    expect(applyClaudePromptEffortPrefix("/security-review", "ultrathink")).toBe(
      "/security-review",
    );
    expect(applyClaudePromptEffortPrefix("/plugin:skill run", "ultrathink")).toBe(
      "/plugin:skill run",
    );
    expect(applyClaudePromptEffortPrefix("/deploy.prod to staging", "ultrathink")).toBe(
      "/deploy.prod to staging",
    );
  });

  it("still adds the ultrathink prefix to ordinary prompts", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this failure", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this failure",
    );
    expect(applyClaudePromptEffortPrefix("/home/theo/app.ts crashed on load", "ultrathink")).toBe(
      "Ultrathink:\n/home/theo/app.ts crashed on load",
    );
  });
});

describe("readCustomModelEntries", () => {
  const capabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
        currentValue: "high",
      },
    ],
  };

  it("resolves bare slugs and entries, trimming and deduplicating on slug", () => {
    expect(
      readCustomModelEntries([
        " bare ",
        { slug: "named", name: " Named ", capabilities },
        "bare",
        { slug: "named", name: "Second" },
        "",
        { name: "no slug" },
        42,
      ]),
    ).toEqual([
      { slug: "bare", name: "bare", capabilities: null },
      { slug: "named", name: "Named", capabilities },
    ]);
  });

  it("drops unparseable capabilities but keeps the entry", () => {
    expect(
      readCustomModelEntries([{ slug: "x", capabilities: { optionDescriptors: "nope" } }]),
    ).toEqual([{ slug: "x", name: "x", capabilities: null }]);
    expect(readCustomModelEntries("not a list")).toEqual([]);
  });
});

describe("provider-reported option display", () => {
  const selection = createModelSelection(ProviderInstanceId.make("opencode"), "ling");
  const reported = { ...selection, options: [{ id: "variant", value: "default" }] };
  const descriptor = {
    id: "variant",
    label: "Reasoning",
    type: "select" as const,
    options: [
      { id: "none", label: "None" },
      { id: "thinking", label: "Thinking" },
    ],
  };

  it("shows explicit reports without adding a choice or a dispatch option", () => {
    expect(getProviderOptionCurrentLabel(descriptor, selection, reported)).toBe("Default");
    expect(
      getProviderOptionCurrentLabel(descriptor, selection, {
        ...reported,
        options: [{ id: "variant", value: "thinking" }],
      }),
    ).toBe("Thinking");
    expect(
      getProviderOptionCurrentLabel(
        { ...descriptor, currentValue: "none" },
        { ...selection, options: [{ id: "variant", value: "none" }] },
        reported,
      ),
    ).toBe("None");
    expect(descriptor.options.map((option) => option.id)).toEqual(["none", "thinking"]);
    expect(buildProviderOptionSelectionsFromDescriptors([descriptor])).toBeUndefined();
    expect(getProviderOptionCurrentLabel(descriptor, selection)).toBe("Unknown");
    const effortDescriptor = { ...descriptor, id: "effort", currentValue: "default" };
    expect(getProviderOptionCurrentLabel(effortDescriptor, selection)).toBeUndefined();
    expect(
      getProviderOptionCurrentLabel(effortDescriptor, selection, {
        ...reported,
        model: "other",
        options: [{ id: "effort", value: "default" }],
      }),
    ).toBeUndefined();
    expect(
      getProviderOptionCurrentLabel(effortDescriptor, selection, {
        ...reported,
        options: [{ id: "effort", value: "default" }],
      }),
    ).toBe("Default");
    expect(
      getProviderOptionCurrentLabel({ ...descriptor, currentValue: "thinking" }, selection),
    ).toBe("Unknown");
  });

  it("shows the catalog's Default choice while no variant is chosen", () => {
    const withDefault = {
      ...descriptor,
      options: [{ id: DEFAULT_VARIANT_CHOICE_ID, label: "Default" }, ...descriptor.options],
      currentValue: DEFAULT_VARIANT_CHOICE_ID,
    };
    expect(getProviderOptionCurrentValue(withDefault, selection)).toBe(DEFAULT_VARIANT_CHOICE_ID);
    expect(getProviderOptionCurrentLabel(withDefault, selection)).toBe("Default");
    expect(
      getProviderOptionCurrentLabel(withDefault, selection, {
        ...reported,
        options: [{ id: "variant", value: "thinking" }],
      }),
    ).toBe("Thinking");
  });

  it.each([
    { ...selection, model: "other" },
    { ...selection, instanceId: ProviderInstanceId.make("other") },
    { ...selection, options: [{ id: "variant", value: "none" }] },
  ])("ignores reports after changing the model, instance, or option: %j", (selected) => {
    expect(getProviderOptionCurrentLabel(descriptor, selected, reported)).toBe("Unknown");
  });
});

describe("withImplicitFastModeDefault", () => {
  // regression: #2981 a remembered Fast mode choice must survive the implicit default on new chats
  it("injects fastMode false only when the model exposes fastMode and no selection exists", () => {
    const caps = createModelCapabilities({
      optionDescriptors: [{ id: "fastMode", label: "Fast", type: "boolean", currentValue: true }],
    });

    expect(withImplicitFastModeDefault(caps, undefined)).toEqual([
      { id: "fastMode", value: false },
    ]);
    expect(withImplicitFastModeDefault(caps, [{ id: "fastMode", value: true }])).toEqual([
      { id: "fastMode", value: true },
    ]);
  });
});
