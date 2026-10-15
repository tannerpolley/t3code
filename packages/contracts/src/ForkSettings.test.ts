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
    topBackButton: false,
    lineageDetailsExpanded: true,
    revealOpenThreadInSidebar: false,
    lineageAutoClearMinutes: 30,
    issuesPage: false,
    versionControlIssues: false,
    pluginSkills: false,
    usageLimitModelBreakdown: false,
    sidebarFiveHourUsage: true,
    dailyUsageMeter: true,
    sidebarWeeklyUsage: true,
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
    chatMath: false,
  },
});

describe("stored fork settings compatibility", () => {
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
      topBackButton: true,
      lineageDetailsExpanded: false,
      revealOpenThreadInSidebar: true,
      lineageAutoClearMinutes: 0,
      issuesPage: true,
      versionControlIssues: true,
      pluginSkills: true,
      usageLimitModelBreakdown: true,
      sidebarFiveHourUsage: false,
      dailyUsageMeter: false,
      sidebarWeeklyUsage: false,
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
      chatMath: true,
    });
  });
});
