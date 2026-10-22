import { describe, expect, it } from "vite-plus/test";

import { resolveProviderSkillSourceKind } from "./providerSkills.ts";

describe("resolveProviderSkillSourceKind", () => {
  it("marks plugin-backed skills as plugins", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
        scope: "user",
      }),
    ).toBe("plugin");
    // A custom provider home hides the path hint; the server-side scope wins.
    expect(
      resolveProviderSkillSourceKind({
        path: "/home/me/.t3/provider-homes/claude/plugins/cache/cse/cse/1/skills/build/SKILL.md",
        scope: "plugin",
      }),
    ).toBe("plugin");
  });
});
