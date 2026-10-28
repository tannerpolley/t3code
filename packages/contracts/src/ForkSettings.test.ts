import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ClientSettingsSchema,
  ClientSettingsPatch,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeServerSettingsFile = Schema.decodeUnknownSync(Schema.fromJsonString(ServerSettings));
const decodeClientSettingsFile = Schema.decodeUnknownSync(
  Schema.fromJsonString(ClientSettingsSchema),
);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeClientPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

// Captured before extraction from settings.ts (da1d4777fc).
const storedSettingsFile = JSON.stringify({
  server: {
    autoOrganizeByFolder: false,
    issueUpkeepRequiresApproval: true,
    dontAskMode: true,
    modelRoles: [
      {
        id: "builder",
        name: "Builder",
        description: "Saved legacy choice",
        target: {
          providerInstanceId: "codex",
          model: "owner-model",
          options: [
            {
              id: "reasoningEffort",
              value: "high",
            },
          ],
        },
      },
    ],
    idleAgentSessionMinutes: 45,
    usageLimitRecovery: "switch",
    usageLimitFallbackModels: [
      {
        instanceId: "codex",
        model: "owner-model",
      },
    ],
    projectFolderRoot: " /work/projects ",
    agentBrowserTabLimits: false,
    localServerHideRules: [
      {
        kind: "process",
        processName: "serena",
      },
    ],
    keepThreadTitlesCurrent: false,
    worktreesDirectory: "project-local",
    projectSettingsOverrides: {
      project: {
        responseStreamingMode: "turn",
      },
    },
  },
  client: {
    keepRunningInBackground: false,
    projectIconFallback: "initials",
    sidebarTogglePosition: "right",
    projectsView: false,
    codexStyleSidebar: false,
    sectionFolderColors: false,
    lineageDetailsExpanded: true,
    revealOpenThreadInSidebar: false,
    lineageAutoClearMinutes: 30,
    issuesPage: false,
    versionControlIssues: false,
    pluginSkills: false,
    branchPickerGroups: false,
    agentBrowserInPanel: false,
    openQuestionsAutomatically: true,
    onboardingCodexSettings: false,
    backgroundProcessOutput: false,
    runningCommandsAndProcesses: false,
    shortModelNames: false,
    lineageInDetails: true,
    threadDetailsRedesign: false,
    fastShimmer: false,
  },
});

describe("stored fork settings compatibility", () => {
  it("discards removed usage customizations in old client settings without losing saved choices", () => {
    const client = {
      projectsView: false,
      sidebarFiveHourUsage: true,
      dailyUsageMeter: true,
      sidebarWeeklyUsage: true,
      usageLimitModelBreakdown: true,
    };
    expect(decodeClientSettingsFile(JSON.stringify(client))).toEqual({
      ...DEFAULT_CLIENT_SETTINGS,
      projectsView: false,
    });
    expect(decodeClientPatch(client)).toEqual({ projectsView: false });
  });

  it("preserves every stored fork field, legacy roles, and omitted-field defaults", () => {
    const stored = JSON.parse(storedSettingsFile);
    const server = decodeServerSettingsFile(JSON.stringify(stored.server));
    const client = decodeClientSettingsFile(JSON.stringify(stored.client));
    const { modelRoles: _legacyRoles, ...serverFields } = stored.server;
    expect(server).toMatchObject({ ...serverFields, projectFolderRoot: "/work/projects" });
    expect(client).toMatchObject(stored.client);
    expect(server.modelRoles[0]).toMatchObject({
      id: "builder",
      targets: stored.server.modelRoles.map((role: { target: unknown }) => role.target),
    });
    expect(server.modelRoles).toHaveLength(7);
    expect(encodeServerSettings(server)).toMatchObject({
      ...serverFields,
      projectFolderRoot: "/work/projects",
      modelRoles: server.modelRoles,
    });
    expect(encodeClientSettings(client)).toMatchObject(stored.client);
    expect(decodeServerPatch(stored.server)).toEqual({
      ...serverFields,
      projectFolderRoot: "/work/projects",
      modelRoles: server.modelRoles,
    });
    // These two local fields were never writable through the patch schema.
    const {
      backgroundProcessOutput: _output,
      runningCommandsAndProcesses: _running,
      ...clientPatch
    } = stored.client;
    expect(decodeClientPatch(stored.client)).toEqual(clientPatch);
    const defaults = {
      server: DEFAULT_SERVER_SETTINGS,
      client: DEFAULT_CLIENT_SETTINGS,
    };
    expect(
      Object.fromEntries(
        Object.keys(serverFields)
          .filter((key) => !["worktreesDirectory", "projectSettingsOverrides"].includes(key))
          .map((key) => [key, defaults.server[key as keyof typeof defaults.server]]),
      ),
    ).toEqual({
      autoOrganizeByFolder: true,
      issueUpkeepRequiresApproval: false,
      dontAskMode: false,
      idleAgentSessionMinutes: 0,
      usageLimitRecovery: "off",
      usageLimitFallbackModels: [],
      projectFolderRoot: "",
      agentBrowserTabLimits: true,
      localServerHideRules: [],
      keepThreadTitlesCurrent: true,
    });
    expect(
      Object.fromEntries(
        Object.keys(stored.client).map((key) => [
          key,
          defaults.client[key as keyof typeof defaults.client],
        ]),
      ),
    ).toEqual({
      keepRunningInBackground: true,
      projectIconFallback: "folder",
      sidebarTogglePosition: "left",
      projectsView: true,
      codexStyleSidebar: true,
      sectionFolderColors: true,
      lineageDetailsExpanded: false,
      revealOpenThreadInSidebar: true,
      lineageAutoClearMinutes: 0,
      issuesPage: true,
      versionControlIssues: true,
      pluginSkills: true,
      branchPickerGroups: true,
      agentBrowserInPanel: true,
      openQuestionsAutomatically: false,
      onboardingCodexSettings: true,
      backgroundProcessOutput: true,
      runningCommandsAndProcesses: true,
      shortModelNames: true,
      lineageInDetails: false,
      threadDetailsRedesign: true,
      fastShimmer: true,
    });
  });
});

it("defaults sidebar text sizes for old settings and validates saved sizes and patches", () => {
  const keys = [
    "sidebarSectionTextSize",
    "sidebarProjectTextSize",
    "sidebarThreadTextSize",
    "sidebarAgentTextSize",
    "sidebarProcessTextSize",
  ] as const;
  const oldSettings = decodeClientSettingsFile("{}");
  for (const key of keys) {
    expect(oldSettings[key]).toBeNull();
    expect(DEFAULT_CLIENT_SETTINGS[key]).toBeNull();
    for (const size of [null, 9, 12, 20]) {
      const saved = { [key]: size };
      expect(encodeClientSettings(decodeClientSettingsFile(JSON.stringify(saved)))[key]).toBe(size);
      expect(decodeClientPatch(saved)).toEqual(saved);
    }
    for (const size of [8, 21, 12.5, "12"]) {
      expect(() => decodeClientSettingsFile(JSON.stringify({ [key]: size }))).toThrow();
      expect(() => decodeClientPatch({ [key]: size })).toThrow();
    }
  }
});

it("defaults to lines without role icons and persists display customizations", () => {
  const visibility = {
    sidebarShowLocation: true,
    sidebarRoleDisplay: "name",
    sidebarShowProvider: true,
    sidebarShowModel: true,
    sidebarShowEffort: true,
    sidebarShowIssueBadge: true,
    sidebarShowPullRequestBadge: true,
  };
  expect(decodeClientSettingsFile("{}")).toMatchObject({
    ...visibility,
    sidebarLocationIconStyle: "worktree",
    sidebarFamilyStyle: "lines",
  });
  const saved = {
    ...Object.fromEntries(
      Object.keys(visibility)
        .filter((key) => key !== "sidebarRoleDisplay")
        .map((key) => [key, false]),
    ),
    sidebarRoleDisplay: "icon",
    sidebarLocationIconStyle: "branch",
    sidebarFamilyStyle: "colors",
  };
  expect(encodeClientSettings(decodeClientSettingsFile(JSON.stringify(saved)))).toMatchObject(
    saved,
  );
  expect(decodeClientPatch(saved)).toEqual(saved);
  expect(() => decodeClientPatch({ sidebarLocationIconStyle: "unknown" })).toThrow();
  expect(() => decodeClientPatch({ sidebarFamilyStyle: "unknown" })).toThrow();
});

it("migrates full legacy client files and saves only the role display choice", () => {
  const { sidebarRoleDisplay: _, ...oldSettings } = DEFAULT_CLIENT_SETTINGS;
  for (const legacy of [true, false, undefined, null, "true"]) {
    const migrated = decodeClientSettingsFile(
      JSON.stringify({ ...oldSettings, sidebarShowRole: legacy }),
    );
    expect(migrated.sidebarRoleDisplay).toBe(legacy === true ? "icon" : "name");
    expect(encodeClientSettings(migrated)).not.toHaveProperty("sidebarShowRole");
  }
  expect(
    decodeClientSettingsFile(
      JSON.stringify({ ...oldSettings, sidebarShowRole: true, sidebarRoleDisplay: "name" }),
    ).sidebarRoleDisplay,
  ).toBe("name");
  expect(() => decodeClientPatch({ sidebarRoleDisplay: "unknown" })).toThrow();
});

it("defaults banked reset automation and reminders on and preserves opt-outs", () => {
  expect(decodeServerSettingsFile("{}").autoUseExpiringResetCredits).toBe(true);
  expect(decodeClientSettingsFile("{}").resetCreditReminders).toBe(true);
  expect(
    encodeServerSettings(decodeServerSettingsFile('{"autoUseExpiringResetCredits":false}'))
      .autoUseExpiringResetCredits,
  ).toBe(false);
  expect(
    encodeClientSettings(decodeClientSettingsFile('{"resetCreditReminders":false}'))
      .resetCreditReminders,
  ).toBe(false);
  expect(decodeServerPatch({ autoUseExpiringResetCredits: false })).toEqual({
    autoUseExpiringResetCredits: false,
  });
  expect(decodeClientPatch({ resetCreditReminders: false })).toEqual({
    resetCreditReminders: false,
  });
});

it("defaults worker provider to mixed and validates saved overrides and patches", () => {
  expect(decodeServerSettingsFile("{}").workerProvider).toBe("mixed");
  for (const workerProvider of ["mixed", "claude", "codex"]) {
    const saved = { workerProvider };
    expect(
      encodeServerSettings(decodeServerSettingsFile(JSON.stringify(saved))).workerProvider,
    ).toBe(workerProvider);
    expect(decodeServerPatch(saved)).toEqual(saved);
  }
  expect(() => decodeServerPatch({ workerProvider: "other" })).toThrow();
});
