import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { discoverClaudeSkills, discoverClaudeSkillsAndPlugins } from "./ClaudeSkills.ts";

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

it.layer(NodeServices.layer)("discoverClaudeSkills", (it) => {
  it.effect("keeps plugin enablement when skill overrides are invalid", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const installPath = path.join(configDir, "plugins", "kept");
      yield* writeSkill(path.join(installPath, "skills"), "review", "# Review");
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: { "kept@shop": [{ scope: "user", installPath }] },
        }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        JSON.stringify({
          skillOverrides: { invalid: false },
          enabledPlugins: { "kept@shop": true },
        }),
      );
      const result = yield* discoverClaudeSkillsAndPlugins({ homePath: configDir });
      assert.deepEqual(
        result.skills.map((skill) => skill.name),
        ["kept:review"],
      );
      assert.deepEqual(
        result.plugins.map((plugin) => plugin.name),
        ["kept"],
      );
    }),
  );
  it.effect("merges plugin enablement and selects installs in native registry order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");
      const nestedWorkspace = path.join(workspace, "packages", "app");
      const aliasedWorkspace = path.join(tempDir, "aliased-workspace");
      const userInstall = path.join(configDir, "plugins", "user");
      const projectInstall = path.join(configDir, "plugins", "project");
      const localInstall = path.join(configDir, "plugins", "local");
      const managedInstall = path.join(configDir, "plugins", "managed");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
      yield* fs.makeDirectory(nestedWorkspace, { recursive: true });
      yield* fs.symlink(workspace, aliasedWorkspace);
      for (const install of [userInstall, projectInstall, localInstall, managedInstall]) {
        yield* writeSkill(path.join(install, "skills"), "review", "# Review");
      }
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            "plugin@shop": [
              { scope: "project", projectPath: aliasedWorkspace, installPath: localInstall },
              { scope: "project", projectPath: workspace, installPath: projectInstall },
              { scope: "user", installPath: userInstall },
              { scope: "managed", installPath: managedInstall },
            ],
            "local@shop": [
              { scope: "local", projectPath: workspace, installPath: localInstall },
              { scope: "project", projectPath: workspace, installPath: projectInstall },
              { scope: "managed", installPath: path.join(configDir, "plugins", "missing") },
              { scope: "managed", installPath: managedInstall },
              { scope: "user", installPath: userInstall },
            ],
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true,"local@shop":false}}',
      );
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.json"),
        '{"enabledPlugins":{"plugin@shop":false,"local@shop":true,"other@shop":["^1.0.0"]}}',
      );
      const projectSettings = yield* discoverClaudeSkills({ homePath: configDir }, workspace);
      assert.deepEqual(
        projectSettings.map((skill) => [skill.name, skill.scope, skill.path]),
        [["local:review", "project", path.join(localInstall, "skills", "review", "SKILL.md")]],
      );
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, nestedWorkspace)).map((skill) => [
          skill.name,
          skill.scope,
          skill.path,
        ]),
        [["plugin:review", "project", path.join(projectInstall, "skills", "review", "SKILL.md")]],
      );
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{"enabledPlugins":{"plugin@shop":true,"local@shop":false},"skillOverrides":{"invalid":"bogus"}}',
      );
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, workspace)).map(
          (skill) => skill.name,
        ),
        ["plugin:review"],
      );
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{"enabledPlugins":{"plugin@shop":true,"local@shop":true}}',
      );
      const localSettings = yield* discoverClaudeSkills({ homePath: configDir }, workspace);
      assert.deepEqual(
        localSettings.map((skill) => [skill.name, skill.scope, skill.path]),
        [
          ["local:review", "project", path.join(localInstall, "skills", "review", "SKILL.md")],
          ["plugin:review", "project", path.join(projectInstall, "skills", "review", "SKILL.md")],
        ],
      );
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, nestedWorkspace),
        localSettings,
      );
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, aliasedWorkspace),
        localSettings,
      );
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{"enabledPlugins":{"local@shop":["^1.0.0"]}}',
      );
      assert.deepEqual(yield* discoverClaudeSkills({ homePath: configDir }, workspace), []);
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true,"local@shop":true}}',
      );
      const separateRepository = path.join(workspace, "separate");
      yield* fs.makeDirectory(path.join(separateRepository, ".git"), { recursive: true });
      for (const cwd of [undefined, path.join(tempDir, "elsewhere"), separateRepository]) {
        const elsewhere = yield* discoverClaudeSkills({ homePath: configDir }, cwd);
        assert.deepEqual(
          elsewhere.map((skill) => [skill.name, skill.scope, skill.path]),
          [
            ["local:review", "user", path.join(managedInstall, "skills", "review", "SKILL.md")],
            ["plugin:review", "user", path.join(userInstall, "skills", "review", "SKILL.md")],
          ],
        );
      }
      const worktree = path.join(tempDir, "worktree");
      const worktreeGitDirectory = path.join(workspace, ".git", "worktrees", "fixture");
      yield* fs.makeDirectory(worktree);
      yield* fs.makeDirectory(worktreeGitDirectory, { recursive: true });
      yield* fs.writeFileString(path.join(worktree, ".git"), `gitdir: ${worktreeGitDirectory}\n`);
      yield* fs.writeFileString(path.join(worktreeGitDirectory, "commondir"), "../..\n");
      yield* fs.writeFileString(
        path.join(worktreeGitDirectory, "gitdir"),
        path.join(worktree, ".git"),
      );
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, worktree),
        localSettings,
      );
      const linkedWorktree = path.join(tempDir, "linked-worktree");
      yield* fs.symlink(worktree, linkedWorktree);
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, linkedWorktree),
        localSettings,
      );
    }),
  );

  it.effect("adds skills of enabled plugins under their namespaced names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");
      const cache = path.join(configDir, "plugins", "cache");
      const install = (name: string, version: string) => path.join(cache, "mk", name, version);

      yield* writeSkill(
        path.join(install("alpha", "1"), "skills"),
        "build",
        ["---", "description: Build it.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(install("alpha", "1"), "skills"),
        "internal",
        ["---", "user-invocable: false", "---"].join("\n"),
      );
      yield* writeSkill(path.join(install("alpha", "project"), "skills"), "local-only", "");
      yield* writeSkill(path.join(install("beta", "1"), "skills"), "hidden", "");
      yield* writeSkill(path.join(install("gamma", "1"), "skills"), "hidden", "");
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        toJson({
          version: 2,
          plugins: {
            "alpha@mk": [
              { scope: "user", installPath: install("alpha", "1") },
              {
                scope: "project",
                projectPath: workspace,
                installPath: install("alpha", "project"),
              },
            ],
            "beta@mk": [{ scope: "user", installPath: install("beta", "1") }],
            "gamma@mk": [{ scope: "user", installPath: install("gamma", "1") }],
            "delta@mk": [
              { scope: "project", projectPath: "/elsewhere", installPath: install("delta", "1") },
            ],
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        toJson({
          enabledPlugins: {
            "alpha@mk": true,
            "beta@mk": false,
            "gamma@mk": true,
            "delta@mk": true,
          },
        }),
      );
      // Project settings layer over the user file, as for skillOverrides.
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.json"),
        toJson({ enabledPlugins: { "gamma@mk": false } }),
      );

      const discovered = yield* discoverClaudeSkillsAndPlugins({ homePath: configDir }, workspace);

      // The native registry order picks the user's alpha install first;
      // delta is installed only for another project.
      assert.deepEqual(
        discovered.skills.map((skill) => [skill.name, skill.scope, skill.pluginName]),
        [
          ["alpha:build", "plugin", "alpha"],
          ["alpha:internal", "plugin", "alpha"],
        ],
      );
      assert.deepEqual(discovered.plugins, [{ name: "alpha", marketplace: "mk", skillCount: 2 }]);

      const outsideProject = yield* discoverClaudeSkillsAndPlugins({ homePath: configDir });
      assert.deepEqual(outsideProject.skills, [
        {
          name: "alpha:build",
          path: path.join(install("alpha", "1"), "skills", "build", "SKILL.md"),
          enabled: true,
          scope: "plugin",
          pluginName: "alpha",
          description: "Build it.",
        },
        {
          name: "alpha:internal",
          path: path.join(install("alpha", "1"), "skills", "internal", "SKILL.md"),
          enabled: true,
          scope: "plugin",
          pluginName: "alpha",
          userInvocable: false,
        },
        {
          name: "gamma:hidden",
          path: path.join(install("gamma", "1"), "skills", "hidden", "SKILL.md"),
          enabled: true,
          scope: "plugin",
          pluginName: "gamma",
        },
      ]);
    }),
  );

  it.effect("follows the skill paths a plugin manifest lists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const installPath = path.join(configDir, "plugins", "cache", "mk", "matt", "1");
      const skills = path.join(installPath, "skills");
      // Grouped in folders, as mattpocock-skills is: one listed skill, one listed folder of
      // skills, and an unlisted folder that stays out.
      yield* writeSkill(
        path.join(skills, "engineering"),
        "tdd",
        ["---", "disable-model-invocation: true", "---"].join("\n"),
      );
      yield* writeSkill(path.join(skills, "misc"), "setup", "");
      yield* writeSkill(path.join(skills, "deprecated"), "old", "");
      yield* fs.makeDirectory(path.join(installPath, ".claude-plugin"));
      yield* fs.writeFileString(
        path.join(installPath, ".claude-plugin", "plugin.json"),
        toJson({ name: "matt", skills: ["./skills/engineering/tdd", "./skills/misc/"] }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        toJson({ plugins: { "matt@mk": [{ scope: "user", installPath }] } }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        toJson({ enabledPlugins: { "matt@mk": true } }),
      );

      const discovered = yield* discoverClaudeSkillsAndPlugins({ homePath: configDir });

      assert.deepEqual(
        discovered.skills.map((skill) => [skill.name, skill.userInvocationOnly === true]),
        [
          ["matt:setup", false],
          ["matt:tdd", true],
        ],
      );
      assert.deepEqual(discovered.plugins, [{ name: "matt", marketplace: "mk", skillCount: 2 }]);
    }),
  );

  it.effect("follows a symlinked plugins directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      // T3's provider home links `plugins` to the user's real Claude home.
      const realPlugins = path.join(tempDir, "real-home", "plugins");
      const configDir = path.join(tempDir, "provider-home");
      const installPath = path.join(configDir, "plugins", "cache", "mk", "cse", "1");
      yield* writeSkill(path.join(realPlugins, "cache", "mk", "cse", "1", "skills"), "build", "");
      yield* fs.writeFileString(
        path.join(realPlugins, "installed_plugins.json"),
        toJson({ plugins: { "cse@mk": [{ scope: "user", installPath }] } }),
      );
      yield* fs.makeDirectory(configDir, { recursive: true });
      yield* fs.symlink(realPlugins, path.join(configDir, "plugins"));
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        toJson({ enabledPlugins: { "cse@mk": true } }),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["cse:build"],
      );
    }),
  );

  it.effect("keeps other skills when installed_plugins.json is missing or malformed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      yield* writeSkill(path.join(configDir, "skills"), "mine", "");
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        toJson({ enabledPlugins: { "cse@mk": true } }),
      );

      const missing = yield* discoverClaudeSkillsAndPlugins({ homePath: configDir });
      assert.deepEqual(
        [missing.skills.map((skill) => skill.name), missing.plugins],
        [["mine"], []],
      );

      yield* fs.makeDirectory(path.join(configDir, "plugins"));
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        '{ "plugins": { "cse@mk": "not-a-list" } }',
      );
      const malformed = yield* discoverClaudeSkillsAndPlugins({ homePath: configDir });
      assert.deepEqual(
        [malformed.skills.map((skill) => skill.name), malformed.plugins],
        [["mine"], []],
      );
    }),
  );
});
