import { assert, it } from "@effect/vitest";

import type * as CodexSchema from "effect-codex-app-server/schema";

import { applyCodexInstalledPlugins } from "./CodexProvider.ts";

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
const account = {
  account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
  requiresOpenaiAuth: false,
} as const;
