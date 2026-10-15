import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { NonNegativeInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ModelSelection } from "./modelSelection.ts";
import { LocalServerHideRule } from "./preview.ts";
import {
  ThreadRole,
  resolveThreadRole,
  modelRoleProfile,
  THREAD_ROLE_LABELS,
} from "./threadRole.ts";

export const ProjectIconFallback = Schema.Literals(["folder", "initials"]);
export type ProjectIconFallback = typeof ProjectIconFallback.Type;

export const SidebarTogglePosition = Schema.Literals(["left", "right"]);
export type SidebarTogglePosition = typeof SidebarTogglePosition.Type;

const MAX_LEGACY_CUSTOM_MODEL_ROLES = 26;
export const MAX_MODEL_ROLES = MAX_LEGACY_CUSTOM_MODEL_ROLES + 6;
// Legacy lists can converge on one profile without discarding any saved choices.
export const MAX_MODEL_ROLE_TARGETS = 12;
export const MAX_MODEL_ROLE_NAME_LENGTH = 60;
export const MAX_MODEL_ROLE_DESCRIPTION_LENGTH = 200;
export const MAX_MODEL_ROLE_MODEL_LENGTH = 100;
export const MAX_MODEL_ROLE_OPTIONS = 8;
export const MAX_MODEL_ROLE_OPTION_LENGTH = 60;

const ModelRoleOptionText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_MODEL_ROLE_OPTION_LENGTH),
);

export const ModelRoleTarget = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_MODEL_ROLE_MODEL_LENGTH)),
  options: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: ModelRoleOptionText,
        value: Schema.Union([ModelRoleOptionText, Schema.Boolean]),
      }),
    ).check(
      Schema.isMaxLength(MAX_MODEL_ROLE_OPTIONS),
      Schema.makeFilter(
        (options) => new Set(options.map((option) => option.id)).size === options.length,
        { expected: "option ids that are each used once" },
      ),
    ),
  ),
});
export type ModelRoleTarget = typeof ModelRoleTarget.Type;

/** Ordered delegation choices; the first is the default. Bounded for per-turn instructions. */
export const ModelRole = Schema.Struct({
  role: Schema.optional(ThreadRole),
  profile: Schema.optional(Schema.Literals(["fast", "thorough"])),
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_MODEL_ROLE_NAME_LENGTH)),
  description: TrimmedString.check(Schema.isMaxLength(MAX_MODEL_ROLE_DESCRIPTION_LENGTH)),
  targets: Schema.NonEmptyArray(ModelRoleTarget).check(Schema.isMaxLength(MAX_MODEL_ROLE_TARGETS)),
});
export type ModelRole = typeof ModelRole.Type;

// Roles saved before multiple choices per role held one `target`.
const LegacyModelRole = Schema.Struct({
  id: ModelRole.fields.id,
  name: ModelRole.fields.name,
  description: ModelRole.fields.description,
  target: Schema.toEncoded(ModelRoleTarget),
}).pipe(
  Schema.decodeTo(
    ModelRole,
    SchemaTransformation.transform({
      decode: ({ target, ...role }): typeof ModelRole.Encoded => ({ ...role, targets: [target] }),
      encode: ({ targets, ...role }) => ({ ...role, target: targets[0] }),
    }),
  ),
);
// Try the current shape first so encoding never writes the legacy `target` key.
const ModelRoleSetting = Schema.Union([ModelRole, LegacyModelRole]);
const SavedModelRoles = Schema.Array(ModelRoleSetting).check(
  Schema.isMaxLength(MAX_MODEL_ROLES),
  Schema.makeFilter(
    (roles) =>
      roles.filter((entry) => entry.role === undefined && resolveThreadRole(entry.id) === undefined)
        .length <= MAX_LEGACY_CUSTOM_MODEL_ROLES,
    { expected: "at most 26 legacy custom roles, leaving room for the standard profiles" },
  ),
);
export const ModelRoles = SavedModelRoles.pipe(
  Schema.decodeTo(
    Schema.Array(Schema.toType(ModelRole)),
    SchemaTransformation.transform({ decode: migrateModelRoles, encode: (roles) => roles }),
  ),
);

const modelRole = (
  id: string,
  name: string,
  description: string,
  providerInstanceId: "claudeAgent" | "codex",
  model: string,
  effort: string,
  alternatives: ReadonlyArray<ModelRoleTarget> = [],
): ModelRole => ({
  id,
  name,
  description,
  targets: [
    {
      providerInstanceId: ProviderInstanceId.make(providerInstanceId),
      model,
      options: [
        { id: providerInstanceId === "codex" ? "reasoningEffort" : "effort", value: effort },
      ],
    },
    ...alternatives,
  ],
});

export const DEFAULT_MODEL_ROLES: ReadonlyArray<ModelRole> = [
  modelRole(
    "orchestrator",
    "Orchestrator",
    "Plans, delegates, integrates",
    "claudeAgent",
    "claude-opus-5-5",
    "high",
  ),
  {
    ...modelRole(
      "implementor-fast",
      "Implementor · Fast",
      "Bounded changes where speed matters; a Checker reviews afterwards",
      "claudeAgent",
      "claude-opus-5-5",
      "medium",
      [
        {
          providerInstanceId: ProviderInstanceId.make("codex"),
          model: "gpt-6.1-sol",
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
      ],
    ),
    role: "implementor",
    profile: "fast" as const,
  },
  {
    ...modelRole(
      "implementor-thorough",
      "Implementor · Thorough",
      "Broad, cross-cutting or correctness-critical implementation",
      "codex",
      "gpt-6.1-sol",
      "high",
    ),
    role: "implementor",
    profile: "thorough" as const,
  },
  modelRole(
    "reviewer",
    "Reviewer",
    "Strong read-only review and design guidance",
    "codex",
    "gpt-6-astra",
    "xhigh",
  ),
  modelRole(
    "investigator",
    "Investigator",
    "Gather evidence and investigate questions",
    "codex",
    "gpt-6-luna",
    "max",
  ),
  modelRole(
    "checker",
    "Checker",
    "Check a build for missed places, weak tests and edge cases",
    "codex",
    "gpt-6.1-sol",
    "high",
  ),
].map((entry) => ({ ...entry, role: resolveThreadRole(entry.id)! }));

/** Default-fill missing profiles, keeping every saved model, option and choice order. */
function migrateModelRoles(saved: ReadonlyArray<ModelRole>): ReadonlyArray<ModelRole> {
  const migrated: Array<ModelRole> = [];
  for (const entry of saved) {
    const role = entry.role ?? resolveThreadRole(entry.id);
    const profile =
      role === "implementor" ? (entry.profile ?? modelRoleProfile(entry.id) ?? "fast") : undefined;
    const id =
      role === undefined ? entry.id : profile === undefined ? role : `implementor-${profile}`;
    const previous = migrated.findIndex((candidate) => candidate.id === id);
    const normalized: ModelRole = {
      ...entry,
      id,
      ...(role === undefined
        ? {}
        : {
            role,
            name: `${THREAD_ROLE_LABELS[role]}${profile ? ` · ${profile === "fast" ? "Fast" : "Thorough"}` : ""}`,
          }),
      ...(profile === undefined ? {} : { profile }),
    };
    if (previous === -1) {
      migrated.push(normalized);
      continue;
    }
    const choices = [...migrated[previous]!.targets, ...entry.targets];
    const targets = choices.filter(
      (target, index) =>
        choices.findIndex(
          (candidate) =>
            candidate.providerInstanceId === target.providerInstanceId &&
            candidate.model === target.model &&
            (candidate.options?.length ?? 0) === (target.options?.length ?? 0) &&
            (candidate.options ?? []).every((option) =>
              (target.options ?? []).some(
                (other) => other.id === option.id && other.value === option.value,
              ),
            ),
        ) === index,
    );
    migrated[previous] = { ...migrated[previous]!, targets: [targets[0]!, ...targets.slice(1)] };
  }
  for (const entry of DEFAULT_MODEL_ROLES) {
    if (!migrated.some((candidate) => candidate.id === entry.id)) migrated.push(entry);
  }
  return migrated;
}

/** Stored in `worktreesDirectory` to select a repository-local folder. */
export const PROJECT_LOCAL_WORKTREES = "project-local";
export const PROJECT_WORKTREES_FOLDER = ".worktrees";

export const UsageLimitRecoveryMode = Schema.Literals(["off", "wait", "switch"]);
export type UsageLimitRecoveryMode = typeof UsageLimitRecoveryMode.Type;

export const ForkClientSettingsFields = {
  // Desktop-only, Linux and Windows: closing the window leaves the app in the
  // system tray so its built-in server and agents keep running.
  keepRunningInBackground: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  projectIconFallback: ProjectIconFallback.pipe(
    Schema.withDecodingDefault(Effect.succeed("folder" as const)),
  ),
  sidebarTogglePosition: SidebarTogglePosition.pipe(
    Schema.withDecodingDefault(Effect.succeed("left" as const)),
  ),
  projectsView: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  codexStyleSidebar: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sectionFolderColors: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  topBackButton: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  lineageDetailsExpanded: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  revealOpenThreadInSidebar: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  lineageAutoClearMinutes: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  issuesPage: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  versionControlIssues: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  pluginSkills: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Usage page Limits laid out like Cost and Tokens (one window kind at a time,
   * provider rows, an estimated by-provider or by-model chart); off shows the
   * per-provider window cards.
   */
  usageLimitModelBreakdown: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sidebarFiveHourUsage: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * The sidebar footer's Usage icon shows today's pace budget left, pacing each
   * Monday–Friday at 20% of each provider's weekly limit.
   */
  dailyUsageMeter: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sidebarWeeklyUsage: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Customizations: this fork's UI changes, each switchable back to the original behavior.
  branchPickerGroups: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  agentBrowserInPanel: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  openQuestionsAutomatically: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  onboardingCodexSettings: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  backgroundProcessOutput: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  runningCommandsAndProcesses: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  shortModelNames: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  lineageInDetails: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  threadDetailsRedesign: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  fastShimmer: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  chatMath: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
};

export const ForkServerSettingsFields = {
  autoOrganizeByFolder: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  issueUpkeepRequiresApproval: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  dontAskMode: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Ordered defaults for delegated work, shown to orchestrating agents in
   * new sessions and turns. Server-side because the prompt is built here.
   */
  modelRoles: ModelRoles.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_MODEL_ROLES))),
  idleAgentSessionMinutes: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  usageLimitRecovery: UsageLimitRecoveryMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("off")),
  ),
  usageLimitFallbackModels: Schema.Array(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  projectFolderRoot: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * Agent browser tabs: a thread keeps at most 3 agent-opened tabs, and a tab stuck loading gets
   * one hard reload and a retry.
   */
  agentBrowserTabLimits: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Local servers the browser panel leaves out. The port scanner skips matching listeners before
   * probing, so they are never sent a request. Restorable in Settings → Customizations.
   */
  localServerHideRules: Schema.Array(LocalServerHideRule).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /**
   * Every ~10 minutes, retitle top-level threads with new messages to what they are working on
   * now, using GPT-6 Luna. Titles a user typed are never changed.
   */
  keepThreadTitlesCurrent: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
};

export const ForkClientSettingsPatchFields = {
  keepRunningInBackground: Schema.optionalKey(Schema.Boolean),
  projectIconFallback: Schema.optionalKey(ProjectIconFallback),
  sidebarTogglePosition: Schema.optionalKey(SidebarTogglePosition),
  projectsView: Schema.optionalKey(Schema.Boolean),
  codexStyleSidebar: Schema.optionalKey(Schema.Boolean),
  sectionFolderColors: Schema.optionalKey(Schema.Boolean),
  topBackButton: Schema.optionalKey(Schema.Boolean),
  lineageDetailsExpanded: Schema.optionalKey(Schema.Boolean),
  revealOpenThreadInSidebar: Schema.optionalKey(Schema.Boolean),
  lineageAutoClearMinutes: Schema.optionalKey(NonNegativeInt),
  issuesPage: Schema.optionalKey(Schema.Boolean),
  versionControlIssues: Schema.optionalKey(Schema.Boolean),
  pluginSkills: Schema.optionalKey(Schema.Boolean),
  usageLimitModelBreakdown: Schema.optionalKey(Schema.Boolean),
  sidebarFiveHourUsage: Schema.optionalKey(Schema.Boolean),
  dailyUsageMeter: Schema.optionalKey(Schema.Boolean),
  sidebarWeeklyUsage: Schema.optionalKey(Schema.Boolean),
  branchPickerGroups: Schema.optionalKey(Schema.Boolean),
  agentBrowserInPanel: Schema.optionalKey(Schema.Boolean),
  openQuestionsAutomatically: Schema.optionalKey(Schema.Boolean),
  onboardingCodexSettings: Schema.optionalKey(Schema.Boolean),
  shortModelNames: Schema.optionalKey(Schema.Boolean),
  lineageInDetails: Schema.optionalKey(Schema.Boolean),
  threadDetailsRedesign: Schema.optionalKey(Schema.Boolean),
  fastShimmer: Schema.optionalKey(Schema.Boolean),
  chatMath: Schema.optionalKey(Schema.Boolean),
};

export const ForkServerSettingsPatchFields = {
  autoOrganizeByFolder: Schema.optionalKey(Schema.Boolean),
  issueUpkeepRequiresApproval: Schema.optionalKey(Schema.Boolean),
  dontAskMode: Schema.optionalKey(Schema.Boolean),
  // Whole-list replacement: roles are ordered and edited as one list.
  modelRoles: Schema.optionalKey(ModelRoles),
  // Server settings
  idleAgentSessionMinutes: Schema.optionalKey(NonNegativeInt),
  usageLimitRecovery: Schema.optionalKey(UsageLimitRecoveryMode),
  usageLimitFallbackModels: Schema.optionalKey(Schema.Array(ModelSelection)),
  projectFolderRoot: Schema.optionalKey(TrimmedString),
  agentBrowserTabLimits: Schema.optionalKey(Schema.Boolean),
  localServerHideRules: Schema.optionalKey(Schema.Array(LocalServerHideRule)),
  keepThreadTitlesCurrent: Schema.optionalKey(Schema.Boolean),
};
