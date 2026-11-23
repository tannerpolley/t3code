import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderOptionSelection } from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { LocalServerHideRule } from "./preview.ts";
import {
  ThreadRoleInput,
  type ThreadRole,
  ModelRoleLevel,
  MODEL_ROLE_LEVELS,
  THREAD_ROLES,
  THREAD_ROLE_LABELS,
} from "./threadRole.ts";

export const ProjectIconFallback = Schema.Literals(["folder", "initials"]);
export type ProjectIconFallback = typeof ProjectIconFallback.Type;

export const SidebarTogglePosition = Schema.Literals(["left", "right"]);
export type SidebarTogglePosition = typeof SidebarTogglePosition.Type;

export const MAX_MODEL_ROLE_DESCRIPTION_LENGTH = 200;
const MAX_MODEL_ROLE_MODEL_LENGTH = 100;
const MAX_MODEL_ROLE_OPTIONS = 8;
const MAX_MODEL_ROLE_OPTION_LENGTH = 60;
export const MAX_MODEL_NOTE_LENGTH = 200;

const ModelRoleOptionLength = Schema.isMaxLength(MAX_MODEL_ROLE_OPTION_LENGTH);

export const ModelRoleTarget = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_MODEL_ROLE_MODEL_LENGTH)),
  options: Schema.optionalKey(
    Schema.Array(
      ProviderOptionSelection.mapFields(({ id, value }) => ({
        id: id.check(ModelRoleOptionLength),
        value: value.mapMembers(([text, flag]) => [text.check(ModelRoleOptionLength), flag]),
      })),
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
  role: Schema.optional(ThreadRoleInput),
  level: Schema.optional(ModelRoleLevel),
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  description: TrimmedString.check(Schema.isMaxLength(MAX_MODEL_ROLE_DESCRIPTION_LENGTH)),
  targets: Schema.NonEmptyArray(ModelRoleTarget).check(Schema.isMaxLength(12)),
});
export type ModelRole = typeof ModelRole.Type;

export const TIER_PROVIDERS = ["claude", "codex"] as const;
export const TIER_PROVIDER_INSTANCES = {
  claude: ProviderInstanceId.make("claudeAgent"),
  codex: ProviderInstanceId.make("codex"),
};
export const TIER_PROVIDER_EFFORT_OPTIONS = { claude: "effort", codex: "reasoningEffort" } as const;
export const ModelRoleProvider = Schema.Literals(["claude", "both", "codex"]);
export type ModelRoleProvider = typeof ModelRoleProvider.Type;
export const ModelRoleEffort = Schema.Literals([
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ModelRoleEffort = typeof ModelRoleEffort.Type;
export const ModelTier = Schema.Literals([1, 2, 3, 4]);
export type ModelTier = typeof ModelTier.Type;

const defaulted = <S extends Schema.Top>(schema: S, value: S["Encoded"]) =>
  schema.pipe(Schema.withDecodingDefault(Effect.succeed(value)));

const ModelNote = TrimmedString.check(Schema.isMaxLength(MAX_MODEL_NOTE_LENGTH));
const TierModel = ModelRoleTarget.fields.model;
const tierSlot = (model: string) =>
  defaulted(
    Schema.Struct({ model: defaulted(TierModel, model), note: defaulted(ModelNote, "") }),
    {},
  );
export const DEFAULT_MODEL_TIERS = {
  1: { claude: "claude-fable-5-2", codex: "gpt-6.2-astra" },
  2: { claude: "claude-opus-5-5", codex: "gpt-6.2-sol" },
  3: { claude: "claude-sonnet-5-5", codex: "gpt-6.1-terra" },
  4: { claude: "claude-haiku-5-5", codex: "gpt-6-luna" },
} as const;
const tier = (id: ModelTier) =>
  defaulted(
    Schema.Struct({
      claude: tierSlot(DEFAULT_MODEL_TIERS[id].claude),
      codex: tierSlot(DEFAULT_MODEL_TIERS[id].codex),
    }),
    {},
  );
const ModelTiers = Schema.Struct({ 1: tier(1), 2: tier(2), 3: tier(3), 4: tier(4) });

const ModelRoleSettingFields = {
  description: ModelRole.fields.description,
  tier: ModelTier,
  provider: ModelRoleProvider,
  effort: ModelRoleEffort,
};
const roleSetting = (
  description: string,
  tierId: ModelTier,
  provider: ModelRoleProvider,
  effort: ModelRoleEffort,
) =>
  defaulted(
    Schema.Struct({
      description: defaulted(ModelRoleSettingFields.description, description),
      tier: defaulted(ModelTier, tierId),
      provider: defaulted(ModelRoleProvider, provider),
      effort: defaulted(ModelRoleEffort, effort),
    }),
    {},
  );

type RoleSetting = ReturnType<typeof roleSetting>;
const roleLevels = (complex: RoleSetting, routine: RoleSetting) =>
  defaulted(Schema.Struct({ complex, routine }), {});

export const ModelRoles = Schema.Struct({
  orchestrator: roleLevels(
    roleSetting("Plans, delegates, integrates", 2, "claude", "medium"),
    roleSetting("Coordinates well-specified work and follows up on results", 3, "claude", "medium"),
  ),
  designer: roleLevels(
    roleSetting(
      "Research requests and design issues with a plan and strategy decisions",
      1,
      "claude",
      "medium",
    ),
    roleSetting("Gather evidence and investigate questions", 2, "claude", "medium"),
  ),
  implementor: roleLevels(
    roleSetting("Broad, cross-cutting or correctness-critical implementation", 2, "codex", "high"),
    roleSetting(
      "Bounded changes with a clear implementation and verification path",
      3,
      "both",
      "medium",
    ),
  ),
  reviewer: roleLevels(
    roleSetting("Strong read-only review and design guidance", 1, "codex", "xhigh"),
    roleSetting("Check a build for missed places, weak tests and edge cases", 2, "codex", "high"),
  ),
  writer: roleLevels(
    roleSetting(
      "Writes deliverables in the parent checkout with direct owner guidance",
      1,
      "claude",
      "high",
    ),
    roleSetting("Edits well-specified deliverables in the parent checkout", 2, "claude", "high"),
  ),
});

const RolePatch = Schema.Struct({
  description: Schema.optionalKey(ModelRoleSettingFields.description),
  tier: Schema.optionalKey(ModelTier),
  provider: Schema.optionalKey(ModelRoleProvider),
  effort: Schema.optionalKey(ModelRoleEffort),
});
const exactRolePatch = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]).check(
    Schema.makeFilter((patch) => Object.keys(patch).every((key) => Object.hasOwn(fields, key)), {
      expected: "only known model role patch fields",
    }),
  );

const RoleLevelsPatch = Schema.optionalKey(
  exactRolePatch({
    routine: Schema.optionalKey(RolePatch),
    complex: Schema.optionalKey(RolePatch),
  }),
);
const ModelRolesPatch = exactRolePatch({
  orchestrator: RoleLevelsPatch,
  designer: RoleLevelsPatch,
  writer: RoleLevelsPatch,
  implementor: RoleLevelsPatch,
  reviewer: RoleLevelsPatch,
});
const TierSlotPatch = Schema.optionalKey(
  Schema.Struct({
    model: Schema.optionalKey(TierModel),
    note: Schema.optionalKey(ModelNote),
  }),
);
const TierPatch = Schema.optionalKey(
  Schema.Struct({ claude: TierSlotPatch, codex: TierSlotPatch }),
);
const ModelTiersPatch = Schema.Struct({ 1: TierPatch, 2: TierPatch, 3: TierPatch, 4: TierPatch });

const CreditsApproved = Schema.Struct({
  claude: defaulted(Schema.Boolean, false),
  codex: defaulted(Schema.Boolean, false),
});

export function resolveModelRoles(settings: {
  readonly modelRoles: typeof ModelRoles.Type;
  readonly modelTiers: typeof ModelTiers.Type;
}): ReadonlyArray<ModelRole & { readonly role: ThreadRole; readonly level: ModelRoleLevel }> {
  return THREAD_ROLES.flatMap((role) =>
    MODEL_ROLE_LEVELS.map((level) => {
      const { description, tier, provider, effort } = settings.modelRoles[role][level];
      const target = (provider: (typeof TIER_PROVIDERS)[number]): ModelRoleTarget => ({
        providerInstanceId: TIER_PROVIDER_INSTANCES[provider],
        model: settings.modelTiers[tier][provider].model,
        ...(effort === "default"
          ? {}
          : {
              options: [{ id: TIER_PROVIDER_EFFORT_OPTIONS[provider], value: effort }],
            }),
      });
      return {
        id: `${role}-${level}`,
        role,
        level,
        name: `${THREAD_ROLE_LABELS[role]} · ${level}`,
        description,
        targets: provider === "both" ? [target("claude"), target("codex")] : [target(provider)],
      };
    }),
  );
}

export function resolveModelNotes(tiers: typeof ModelTiers.Type) {
  return ModelTier.literals.flatMap((tier) =>
    TIER_PROVIDERS.flatMap((provider) => {
      const { model, note } = tiers[tier][provider];
      return note === ""
        ? []
        : [{ providerInstanceId: TIER_PROVIDER_INSTANCES[provider], model, note }];
    }),
  );
}

/** Stored in `worktreesDirectory` to select a repository-local folder. */
export const PROJECT_LOCAL_WORKTREES = "project-local";
export const PROJECT_WORKTREES_FOLDER = ".worktrees";

export const UsageLimitRecoveryMode = Schema.Literals(["off", "wait", "switch"]);
export type UsageLimitRecoveryMode = typeof UsageLimitRecoveryMode.Type;

export const MIN_SIDEBAR_TEXT_SIZE = 9;
export const MAX_SIDEBAR_TEXT_SIZE = 20;
// Null keeps the row's style-specific default; numbers are pixels at a 16px interface font.
/** A custom color for the sidebar's family and checkout lines; null keeps the theme's. */
export const SidebarLineColor = Schema.NullOr(
  Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/i)),
);

export const SidebarTextSize = Schema.NullOr(
  Schema.Int.check(
    Schema.isBetween({ minimum: MIN_SIDEBAR_TEXT_SIZE, maximum: MAX_SIDEBAR_TEXT_SIZE }),
  ),
);

export const SidebarRoleDisplay = Schema.Literals(["name", "icon"]);

export function migrateSidebarRoleDisplay(settings: {
  readonly sidebarRoleDisplay?: "name" | "icon" | undefined;
  readonly sidebarShowRole?: unknown;
}) {
  return settings.sidebarRoleDisplay ?? (settings.sidebarShowRole === true ? "icon" : "name");
}

export const ForkClientSettingsFields = {
  resetCreditReminders: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
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
  sidebarShowLocation: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sidebarRoleDisplay: Schema.optionalKey(SidebarRoleDisplay),
  sidebarShowProvider: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sidebarShowModel: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sidebarShowModelVersion: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sidebarShowEffort: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sidebarShowIssueBadge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sidebarShowPullRequestBadge: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  sidebarLocationIconStyle: Schema.Literals(["worktree", "branch"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("worktree" as const)),
  ),
  sidebarFamilyStyle: Schema.Literals(["colors", "lines"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("lines" as const)),
  ),
  sidebarLineColor: SidebarLineColor.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  sidebarSectionTextSize: SidebarTextSize.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  sidebarProjectTextSize: SidebarTextSize.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  sidebarThreadTextSize: SidebarTextSize.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  sidebarAgentTextSize: SidebarTextSize.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  sidebarProcessTextSize: SidebarTextSize.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  sectionFolderColors: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  lineageDetailsExpanded: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  revealOpenThreadInSidebar: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  lineageAutoClearMinutes: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** List the thread repository's issues in thread details. */
  versionControlIssues: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Offer Claude Code plugin skills in the composer menus, labeled Plugin. */
  pluginSkills: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Customizations: this fork's UI changes, each switchable back to the original behavior.
  branchPickerGroups: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Show a browser tab an agent uses in the right panel instead of the floating mini player. */
  agentBrowserInPanel: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Show a new question from any thread in a floating panel, to answer without opening it. */
  openQuestionsAutomatically: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  /** Offer to apply supported Codex project settings when onboarding imports projects. */
  onboardingCodexSettings: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Clicking a background command or monitor shows its live output in a popup. */
  backgroundProcessOutput: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Experimental: a working thread's running commands and the processes they spawned. */
  runningCommandsAndProcesses: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  /** Model labels drop the company name the provider icon already shows: "Opus 5.5", "Sol 6". */
  shortModelNames: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Lineage rows led by model and effort, with status marks, details and clearing. */
  threadDetailsRedesign: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** The quicker running-activity shimmer. */
  fastShimmer: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
};

const ToolOutputRetentionDays = Schema.NullOr(NonNegativeInt.check(Schema.isGreaterThan(0)));

const AwayMode = Schema.Literals(["auto", "away", "here"]);
const AwayIdleMinutes = NonNegativeInt.check(Schema.isGreaterThan(0));

export const ForkServerSettingsFields = {
  quietThreadMinutes: defaulted(NonNegativeInt, 10),
  awayMode: AwayMode.pipe(Schema.withDecodingDefault(Effect.succeed("auto"))),
  awayIdleMinutes: AwayIdleMinutes.pipe(Schema.withDecodingDefault(Effect.succeed(5))),
  toolOutputRetentionDays: ToolOutputRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(14)),
  ),
  autoUseExpiringResetCredits: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  autoOrganizeByFolder: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  issueUpkeepRequiresApproval: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  /** User-only: the server answers every pending agent question and approval while on. */
  dontAskMode: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Outside agents' MCP sign-ins the owner lets answer approvals, as well as questions, in
   * threads that sign-in started and their subagents. Set in Settings → Sharing & access.
   */
  mcpApprovalRelaySessionIds: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  modelRoles: defaulted(ModelRoles, {}),
  modelTiers: defaulted(ModelTiers, {}),
  providerCreditsApproved: defaulted(CreditsApproved, {}),
  /** Disconnect agent sessions after this many idle minutes; 0 keeps sessions open. */
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
   * probing, so they are never sent a request. Restorable in Settings → Integrations.
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
  resetCreditReminders: Schema.optionalKey(Schema.Boolean),
  keepRunningInBackground: Schema.optionalKey(Schema.Boolean),
  projectIconFallback: Schema.optionalKey(ProjectIconFallback),
  sidebarTogglePosition: Schema.optionalKey(SidebarTogglePosition),
  projectsView: Schema.optionalKey(Schema.Boolean),
  codexStyleSidebar: Schema.optionalKey(Schema.Boolean),
  sidebarShowLocation: Schema.optionalKey(Schema.Boolean),
  sidebarRoleDisplay: Schema.optionalKey(SidebarRoleDisplay),
  sidebarShowProvider: Schema.optionalKey(Schema.Boolean),
  sidebarShowModel: Schema.optionalKey(Schema.Boolean),
  sidebarShowModelVersion: Schema.optionalKey(Schema.Boolean),
  sidebarShowEffort: Schema.optionalKey(Schema.Boolean),
  sidebarShowIssueBadge: Schema.optionalKey(Schema.Boolean),
  sidebarShowPullRequestBadge: Schema.optionalKey(Schema.Boolean),
  sidebarLocationIconStyle: Schema.optionalKey(Schema.Literals(["worktree", "branch"])),
  sidebarFamilyStyle: Schema.optionalKey(Schema.Literals(["colors", "lines"])),
  sidebarLineColor: Schema.optionalKey(SidebarLineColor),
  sidebarSectionTextSize: Schema.optionalKey(SidebarTextSize),
  sidebarProjectTextSize: Schema.optionalKey(SidebarTextSize),
  sidebarThreadTextSize: Schema.optionalKey(SidebarTextSize),
  sidebarAgentTextSize: Schema.optionalKey(SidebarTextSize),
  sidebarProcessTextSize: Schema.optionalKey(SidebarTextSize),
  sectionFolderColors: Schema.optionalKey(Schema.Boolean),
  lineageDetailsExpanded: Schema.optionalKey(Schema.Boolean),
  revealOpenThreadInSidebar: Schema.optionalKey(Schema.Boolean),
  lineageAutoClearMinutes: Schema.optionalKey(NonNegativeInt),
  versionControlIssues: Schema.optionalKey(Schema.Boolean),
  pluginSkills: Schema.optionalKey(Schema.Boolean),
  branchPickerGroups: Schema.optionalKey(Schema.Boolean),
  agentBrowserInPanel: Schema.optionalKey(Schema.Boolean),
  openQuestionsAutomatically: Schema.optionalKey(Schema.Boolean),
  onboardingCodexSettings: Schema.optionalKey(Schema.Boolean),
  shortModelNames: Schema.optionalKey(Schema.Boolean),
  threadDetailsRedesign: Schema.optionalKey(Schema.Boolean),
  fastShimmer: Schema.optionalKey(Schema.Boolean),
};

export const ForkServerSettingsPatchFields = {
  quietThreadMinutes: Schema.optionalKey(NonNegativeInt),
  awayMode: Schema.optionalKey(AwayMode),
  awayIdleMinutes: Schema.optionalKey(AwayIdleMinutes),
  toolOutputRetentionDays: Schema.optionalKey(ToolOutputRetentionDays),
  autoUseExpiringResetCredits: Schema.optionalKey(Schema.Boolean),
  autoOrganizeByFolder: Schema.optionalKey(Schema.Boolean),
  issueUpkeepRequiresApproval: Schema.optionalKey(Schema.Boolean),
  dontAskMode: Schema.optionalKey(Schema.Boolean),
  mcpApprovalRelaySessionIds: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  modelRoles: Schema.optionalKey(ModelRolesPatch),
  modelTiers: Schema.optionalKey(ModelTiersPatch),
  providerCreditsApproved: Schema.optionalKey(
    Schema.Struct({
      claude: Schema.optionalKey(Schema.Boolean),
      codex: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  idleAgentSessionMinutes: Schema.optionalKey(NonNegativeInt),
  usageLimitRecovery: Schema.optionalKey(UsageLimitRecoveryMode),
  usageLimitFallbackModels: Schema.optionalKey(Schema.Array(ModelSelection)),
  projectFolderRoot: Schema.optionalKey(TrimmedString),
  agentBrowserTabLimits: Schema.optionalKey(Schema.Boolean),
  localServerHideRules: Schema.optionalKey(Schema.Array(LocalServerHideRule)),
  keepThreadTitlesCurrent: Schema.optionalKey(Schema.Boolean),
};
