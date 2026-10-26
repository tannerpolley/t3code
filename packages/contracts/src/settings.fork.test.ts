import { RepositoryMilestonePlan } from "./issueWork.ts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  DEFAULT_MODEL_ROLES,
  DEFAULT_SERVER_SETTINGS,
  MAX_MODEL_ROLE_DESCRIPTION_LENGTH,
  MAX_MODEL_ROLE_MODEL_LENGTH,
  MAX_MODEL_ROLE_OPTION_LENGTH,
  MAX_MODEL_ROLE_OPTIONS,
  MAX_MODEL_ROLE_TARGETS,
  MAX_MODEL_ROLES,
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
  const role = DEFAULT_MODEL_ROLES[0]!;

  it("seeds the default roles into settings files written before roles existed", () => {
    const roles = decodeServerSettings({ enableAgentBrowserAccess: false }).modelRoles;
    expect(roles.map((entry) => entry.name)).toEqual([
      "Orchestrator",
      "Implementor · Fast",
      "Implementor · Thorough",
      "Reviewer",
      "Investigator",
      "Checker",
    ]);
    expect(new Set(roles.map((entry) => entry.role))).toEqual(
      new Set(["orchestrator", "implementor", "reviewer", "investigator", "checker"]),
    );
  });

  it("decodes saved single-target roles and encodes only the new shape", () => {
    const { targets, ...metadata } = role;
    const legacy = { ...metadata, target: targets[0] };
    const decoded = decodeServerSettings({ modelRoles: [legacy] });
    expect(decoded.modelRoles[0]).toEqual({ ...metadata, targets: [targets[0]] });
    expect(decoded.modelRoles).toHaveLength(DEFAULT_MODEL_ROLES.length);
    expect(encodeServerSettings(decoded).modelRoles).toEqual(decoded.modelRoles);
    expect(encodeServerSettings(decoded).modelRoles?.[0]).not.toHaveProperty("target");
    expect(decodeServerSettingsPatch({ modelRoles: [legacy] }).modelRoles).toEqual(
      decoded.modelRoles,
    );
  });

  it("seeds the Fast Implementor profile with Claude medium and Codex Sol medium, in default order", () => {
    expect(decodeServerSettings({}).modelRoles[1]!.targets).toEqual([
      {
        providerInstanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "medium" }],
      },
      {
        providerInstanceId: "codex",
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "medium" }],
      },
    ]);
  });

  it("fills missing standard profiles without replacing configured choices", () => {
    expect(decodeServerSettings({ modelRoles: [] }).modelRoles).toEqual(DEFAULT_MODEL_ROLES);
    const configured = {
      ...role,
      targets: [
        { ...role.targets[0], model: "owner-model", options: [{ id: "effort", value: "max" }] },
      ],
    };
    const decoded = decodeServerSettings({ modelRoles: [configured] });
    expect(decoded.modelRoles[0]).toEqual(configured);
    expect(decoded.modelRoles).toHaveLength(DEFAULT_MODEL_ROLES.length);
    expect(decodeServerSettings(encodeServerSettings(decoded)).modelRoles).toEqual(
      decoded.modelRoles,
    );
    expect(decodeServerSettingsPatch({ modelRoles: [configured] }).modelRoles).toEqual(
      decoded.modelRoles,
    );
  });

  it("migrates every old role and keeps every configured model and effort in its profile", () => {
    const oldIds = [
      "orchestrator",
      "fast-builder",
      "checker",
      "thorough-builder",
      "bounded-worker",
      "evidence-gatherer",
      "quick-claude",
      "strong-reviewer",
    ];
    const saved = oldIds.map((id, index) => ({
      id,
      name: id,
      description: `owner description ${index}`,
      targets: [
        {
          providerInstanceId: index % 2 ? "claudeAgent" : "codex",
          model: `owner-${index}`,
          options: [
            { id: index % 2 ? "effort" : "reasoningEffort", value: index % 2 ? "medium" : "high" },
          ],
        },
      ],
    }));
    const roles = decodeServerSettings({ modelRoles: saved }).modelRoles;
    expect(roles.find((entry) => entry.id === "implementor-fast")?.targets).toEqual([
      saved[1]!.targets[0],
      saved[4]!.targets[0],
      saved[6]!.targets[0],
    ]);
    expect(roles.find((entry) => entry.id === "implementor-thorough")?.targets).toEqual(
      saved[3]!.targets,
    );
    expect(roles.find((entry) => entry.id === "investigator")?.targets).toEqual(saved[5]!.targets);
    expect(roles.find((entry) => entry.id === "reviewer")?.targets).toEqual(saved[7]!.targets);
    expect(roles.find((entry) => entry.id === "checker")?.targets).toEqual(saved[2]!.targets);
    expect(
      roles
        .flatMap((entry) => entry.targets)
        .map((target) => target.model)
        .sort(),
    ).toEqual(
      saved
        .flatMap((entry) => entry.targets)
        .map((target) => target.model)
        .sort(),
    );
    expect(
      decodeServerSettings(encodeServerSettings({ ...DEFAULT_SERVER_SETTINGS, modelRoles: roles }))
        .modelRoles,
    ).toEqual(roles);
    const single = saved.map(({ targets, ...entry }) => ({ ...entry, target: targets[0] }));
    expect(decodeServerSettings({ modelRoles: single }).modelRoles).toEqual(roles);
  });

  it("deduplicates merged choices while preserving distinct efforts and first-choice order", () => {
    const target = {
      providerInstanceId: "codex",
      model: "gpt-6.1-sol",
      options: [
        { id: "reasoningEffort", value: "medium" },
        { id: "serviceTier", value: "default" },
      ],
    };
    const high = { ...target, options: [{ id: "reasoningEffort", value: "high" }] };
    const saved = [
      { id: "fast-builder", name: "Fast", description: "First description", targets: [target] },
      {
        id: "bounded-worker",
        name: "Worker",
        description: "Other description",
        targets: [{ ...target, options: target.options.toReversed() }, high],
      },
      { id: "quick-claude", name: "Quick", description: "Third description", targets: [target] },
    ];
    const decoded = decodeServerSettings({ modelRoles: saved });
    const fast = decoded.modelRoles.find((entry) => entry.id === "implementor-fast")!;
    expect(fast.targets).toEqual([target, high]);
    expect(fast.description).toBe("First description");
    expect(decodeServerSettings(encodeServerSettings(decoded)).modelRoles).toEqual(
      decoded.modelRoles,
    );
  });

  it("round-trips twelve distinct choices merged into the Fast profile", () => {
    const saved = ["fast-builder", "bounded-worker", "quick-claude"].map((id, roleIndex) => ({
      id,
      name: id,
      description: "Owner configured",
      targets: Array.from({ length: 4 }, (_, choiceIndex) => ({
        providerInstanceId: "codex",
        model: `owner-${roleIndex}-${choiceIndex}`,
      })),
    }));
    const decoded = decodeServerSettings({ modelRoles: saved });
    expect(decoded.modelRoles.find((entry) => entry.id === "implementor-fast")!.targets).toEqual(
      saved.flatMap((entry) => entry.targets),
    );
    expect(decodeServerSettings(encodeServerSettings(decoded)).modelRoles).toEqual(
      decoded.modelRoles,
    );
  });

  it("keeps saved issue-work profile references usable after the settings migration", () => {
    const decode = Schema.decodeUnknownSync(RepositoryMilestonePlan);
    const mappings = {
      "fast-builder": "implementor-fast",
      "bounded-worker": "implementor-fast",
      "quick-claude": "implementor-fast",
      "thorough-builder": "implementor-thorough",
      "evidence-gatherer": "investigator",
      "strong-reviewer": "reviewer",
      checker: "checker",
      "custom-role": "custom-role",
    };
    for (const [oldId, id] of Object.entries(mappings)) {
      expect(
        decode({
          number: 1,
          modelRoleId: oldId,
          workspace: "project",
          status: "running",
          fingerprint: "",
        }).modelRoleId,
      ).toBe(id);
    }
  });

  it.each([20, 21, 26])(
    "preserves %i legacy custom roles when filling standard defaults",
    (count) => {
      const custom = Array.from({ length: count }, (_, index) => ({
        ...role,
        role: undefined,
        id: `custom-${index}`,
      }));
      const decoded = decodeServerSettings({ modelRoles: custom });
      expect(decoded.modelRoles.slice(0, count)).toEqual(custom);
      expect(decodeServerSettings(encodeServerSettings(decoded)).modelRoles).toEqual(
        decoded.modelRoles,
      );
    },
  );

  it("bounds the role count and description length", () => {
    const many = Array.from({ length: MAX_MODEL_ROLES + 1 }, (_, index) => ({
      ...role,
      id: `role-${index}`,
    }));
    expect(() => decodeServerSettingsPatch({ modelRoles: many })).toThrow();
    expect(() =>
      decodeServerSettingsPatch({
        modelRoles: [{ ...role, description: "x".repeat(MAX_MODEL_ROLE_DESCRIPTION_LENGTH + 1) }],
      }),
    ).toThrow();
  });

  it("bounds choices per role while allowing merged legacy lists", () => {
    const withCount = (count: number) => ({
      modelRoles: [
        {
          ...role,
          targets: Array.from({ length: count }, (_, index) => ({
            ...role.targets[0],
            model: `choice-${index}`,
          })),
        },
      ],
    });
    expect(
      decodeServerSettingsPatch(withCount(MAX_MODEL_ROLE_TARGETS)).modelRoles?.[0]?.targets,
    ).toEqual(withCount(MAX_MODEL_ROLE_TARGETS).modelRoles[0]!.targets);
    expect(() => decodeServerSettingsPatch(withCount(0))).toThrow();
    expect(() => decodeServerSettingsPatch(withCount(MAX_MODEL_ROLE_TARGETS + 1))).toThrow();
  });

  it("bounds the target at its limits and rejects duplicate option ids", () => {
    const withTarget = (target: object) => ({
      modelRoles: [{ ...role, targets: [{ ...role.targets[0], ...target }] }],
    });
    const options = (count: number, length: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `${index}${"i".repeat(length - 1)}`,
        value: "v".repeat(length),
      }));
    const largest = withTarget({
      model: "m".repeat(MAX_MODEL_ROLE_MODEL_LENGTH),
      options: options(MAX_MODEL_ROLE_OPTIONS, MAX_MODEL_ROLE_OPTION_LENGTH),
    });
    expect(decodeServerSettingsPatch(largest).modelRoles?.[0]).toEqual(largest.modelRoles[0]);
    for (const invalid of [
      { model: "m".repeat(MAX_MODEL_ROLE_MODEL_LENGTH + 1) },
      { options: options(MAX_MODEL_ROLE_OPTIONS + 1, 2) },
      { options: options(1, MAX_MODEL_ROLE_OPTION_LENGTH + 1) },
      {
        options: [
          { id: "effort", value: "high" },
          { id: "effort", value: "low" },
        ],
      },
    ]) {
      expect(() => decodeServerSettingsPatch(withTarget(invalid))).toThrow();
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
  it("hides Lineage in the thread details pane by default", () => {
    expect(decodeClientSettings({}).lineageInDetails).toBe(false);
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
      lineageInDetails: true,
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
