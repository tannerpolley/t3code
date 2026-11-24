import { ModelRoleId } from "./threadRole.ts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  DEFAULT_MODEL_TIERS,
  MAX_MODEL_NOTE_LENGTH,
  resolveModelRoles,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

describe("model roles", () => {
  it("fills sparse settings and resolves each provider choice with the role's effort", () => {
    const saved = {
      modelRoles: { reviewer: { complex: { provider: "both", effort: "medium" } } },
      modelTiers: { 1: { claude: { note: "Writing and research" } } },
      providerCreditsApproved: { codex: true },
    };
    const settings = decodeServerSettings(saved);
    const roles = resolveModelRoles(settings);
    expect(roles.map(({ name }) => name)).toEqual([
      "Orchestrator · complex",
      "Orchestrator · routine",
      "Designer · complex",
      "Designer · routine",
      "Implementor · complex",
      "Implementor · routine",
      "Reviewer · complex",
      "Reviewer · routine",
      "Writer · complex",
      "Writer · routine",
    ]);
    expect(roles.find(({ id }) => id === "reviewer-complex")?.targets).toEqual([
      {
        providerInstanceId: "claudeAgent",
        model: DEFAULT_MODEL_TIERS[1].claude,
        options: [{ id: "effort", value: "medium" }],
      },
      {
        providerInstanceId: "codex",
        model: DEFAULT_MODEL_TIERS[1].codex,
        options: [{ id: "reasoningEffort", value: "medium" }],
      },
    ]);
    expect(
      roles.find(({ id }) => id === "reviewer-routine")?.targets.map(({ model }) => model),
    ).toEqual(["gpt-6.2-sol"]);
    expect(
      roles.find(({ id }) => id === "writer-complex")?.targets.map(({ model }) => model),
    ).toEqual(["claude-fable-5-2"]);
    expect(settings.providerCreditsApproved).toEqual({ claude: false, codex: true });
    expect(decodeServerSettings(encodeServerSettings(settings))).toEqual(settings);
    expect(decodeServerSettingsPatch(saved)).toEqual(saved);
    expect(() =>
      decodeServerSettingsPatch({
        modelTiers: { 1: { codex: { note: "x".repeat(MAX_MODEL_NOTE_LENGTH + 1) } } },
      }),
    ).toThrow();
  });

  it("rejects legacy model-role patch fields instead of dropping the edit", () => {
    expect(() =>
      decodeServerSettingsPatch({
        modelRoles: { reviewer: { effort: "medium" } },
      }),
    ).toThrow();
    expect(() =>
      decodeServerSettingsPatch({
        modelRoles: { checker: { provider: "both" } },
      }),
    ).toThrow();
  });

  it("keeps saved issue-work role references usable after the settings migration", () => {
    const decode = Schema.decodeUnknownSync(ModelRoleId);
    const mappings = {
      "fast-builder": "implementor-routine",
      "bounded-worker": "implementor-routine",
      "quick-claude": "implementor-routine",
      "thorough-builder": "implementor-complex",
      "evidence-gatherer": "designer-routine",
      "strong-reviewer": "reviewer-complex",
      checker: "reviewer-routine",
      investigator: "designer-routine",
      "implementor-fast": "implementor-routine",
      "implementor-thorough": "implementor-complex",
      implementor: "implementor-complex",
      orchestrator: "orchestrator-complex",
      "custom-role": "custom-role",
    };
    const roleIds = resolveModelRoles(decodeServerSettings({})).map(({ id }) => id);
    for (const [oldId, id] of Object.entries(mappings)) {
      if (oldId !== "custom-role") expect(roleIds).toContain(id);
      expect(decode(oldId)).toBe(id);
    }
  });
});

describe("fork sidebar preferences", () => {
  it("keeps folder automation on the environment rather than in client preferences", () => {
    expect(decodeServerSettings({ autoOrganizeByFolder: false }).autoOrganizeByFolder).toBe(false);
    expect(decodeServerSettingsPatch({ autoOrganizeByFolder: false })).toEqual({
      autoOrganizeByFolder: false,
    });
    expect(decodeClientSettings({ autoOrganizeByFolder: false })).not.toHaveProperty(
      "autoOrganizeByFolder",
    );
  });
  it("retains existing persisted settings through snapshots, encoding, and patches", () => {
    const input = {
      projectsView: false,
      codexStyleSidebar: false,
      sectionFolderColors: false,
      projectIconFallback: "initials",
      sidebarTogglePosition: "right",
      revealOpenThreadInSidebar: false,
      lineageDetailsExpanded: true,
      lineageAutoClearMinutes: 5,
    };
    expect(encodeClientSettings(decodeClientSettings(input))).toMatchObject(input);
    expect(decodeClientSettingsPatch(input)).toEqual(input);
    expect(decodeClientSettings({ activityNeedsYouFirst: true })).not.toHaveProperty(
      "activityNeedsYouFirst",
    );
    expect(() => decodeClientSettingsPatch({ lineageAutoClearMinutes: -1 })).toThrow();
    expect(
      encodeServerSettings(decodeServerSettings({ projectFolderRoot: "/work" })),
    ).toMatchObject({ projectFolderRoot: "/work" });
    expect(decodeServerSettingsPatch({ projectFolderRoot: "/work" })).toEqual({
      projectFolderRoot: "/work",
    });
  });
});
