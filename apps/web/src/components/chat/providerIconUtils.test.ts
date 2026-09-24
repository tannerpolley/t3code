import { describe, expect, it } from "vite-plus/test";

import { shortModelName } from "./providerIconUtils";

describe("shortModelName", () => {
  it.each([
    // Claude catalog, Pi's copies and a Claude Code context suffix.
    ["Claude Opus 5.5", "Opus 5.5"],
    ["Claude Sonnet 5", "Sonnet 5"],
    ["Claude Haiku 4.5 (latest)", "Haiku 4.5 (latest)"],
    ["Claude Opus 4.6 (1M context)", "Opus 4.6 (1M context)"],
    // Codex hyphenates codenames; Pi spaces them.
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
