import { describe, expect, it } from "vite-plus/test";

import { getDisplayModelName, getProviderRowLabel, shortModelName } from "./providerIconUtils";

describe("getProviderRowLabel", () => {
  it("shows a sub-provider named after its provider on its own", () => {
    expect(getProviderRowLabel("OpenCode", "OpenCode Zen")).toBe("OpenCode Zen");
    expect(getProviderRowLabel("OpenCode", "OpenCode Go")).toBe("OpenCode Go");
  });

  it("keeps a provider id that merely starts like the provider name", () => {
    expect(getProviderRowLabel("OpenCode", "opencode-go")).toBe("OpenCode · opencode-go");
  });

  it("joins a sub-provider that names something else", () => {
    expect(getProviderRowLabel("OpenCode", "GitHub Copilot")).toBe("OpenCode · GitHub Copilot");
  });

  it("keeps the provider name when a model has no sub-provider", () => {
    expect(getProviderRowLabel("Claude", undefined)).toBe("Claude");
  });
});

describe("getDisplayModelName", () => {
  it("drops a leading sub-provider qualifier from the model name", () => {
    expect(
      getDisplayModelName({
        slug: "a/b",
        name: "OpenCode Zen: Step 5",
        subProvider: "OpenCode Zen",
      }),
    ).toBe("Step 5");
  });
});

describe("shortModelName", () => {
  it.each([
    // Claude catalog and a Claude Code context suffix.
    ["Claude Opus 5.5", "Opus 5.5"],
    ["Claude Sonnet 5", "Sonnet 5"],
    ["Claude Haiku 4.5 (latest)", "Haiku 4.5 (latest)"],
    ["Claude Opus 4.6 (1M context)", "Opus 4.6 (1M context)"],
    // Codex hyphenates codenames; other catalogs space them.
    ["GPT-6-Sol", "Sol 6"],
    ["GPT-6 Luna", "Luna 6"],
    ["GPT-5.6-Terra", "Terra 5.6"],
    // No codename: kept whole.
    ["GPT-5.4", "GPT-5.4"],
    ["GPT-5.3 Codex", "GPT-5.3 Codex"],
    ["GPT-5.3 Codex Spark", "GPT-5.3 Codex Spark"],
    ["GPT-5.4-Mini", "GPT-5.4-Mini"],
    // Antigravity's Gemini names.
    ["Gemini 3.8 Flash (High)", "Flash 3.8 (High)"],
    // Other providers' names and raw slugs are left alone.
    ["Grok 4.6", "Grok 4.6"],
    ["Composer 2", "Composer 2"],
    ["Opus 4.8", "Opus 4.8"],
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["gpt-6-sol", "gpt-6-sol"],
  ])("%s → %s", (name, expected) => {
    expect(shortModelName(name)).toBe(expected);
  });
});
