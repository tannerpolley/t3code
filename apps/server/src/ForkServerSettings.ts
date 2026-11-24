import {
  DEFAULT_MODEL_TIERS,
  DEFAULT_ORCHESTRATOR_HANDOFF_COMPACTIONS,
  DEFAULT_SERVER_SETTINGS,
  ModelRole,
  ModelRoleEffort,
  type ModelRoleLevel,
  ModelRoleProvider,
  resolveModelRoleName,
  ModelRoles,
  ModelTier,
  type ServerSettings,
  type ThreadRole,
  TIER_PROVIDER_EFFORT_OPTIONS,
  TIER_PROVIDER_INSTANCES,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ForkPersistedServerSettingsFields = {
  usageLimitRecovery: Schema.optionalKey(Schema.Unknown),
};

const defaulted = <S extends Schema.Top>(schema: S, value: S["Encoded"]) =>
  schema.pipe(Schema.withDecodingDefault(Effect.succeed(value)));

const roleSetting = (
  description: string,
  tier: ModelTier,
  provider: ModelRoleProvider,
  effort: ModelRoleEffort,
) =>
  defaulted(
    Schema.Struct({
      description: defaulted(ModelRole.fields.description, description),
      tier: defaulted(ModelTier, tier),
      provider: defaulted(ModelRoleProvider, provider),
      effort: defaulted(ModelRoleEffort, effort),
    }),
    {},
  );

const LegacyModelRoles = Schema.Struct({
  orchestrator: roleSetting("Plans, delegates, integrates", 2, "claude", "medium"),
  designer: roleSetting(
    "Research requests and design issues with a plan and strategy decisions",
    1,
    "claude",
    "medium",
  ),
  "implementor-fast": roleSetting(
    "Bounded changes where speed matters; a Checker reviews afterwards",
    3,
    "both",
    "medium",
  ),
  checker: roleSetting(
    "Check a build for missed places, weak tests and edge cases",
    2,
    "codex",
    "high",
  ),
  "implementor-thorough": roleSetting(
    "Broad, cross-cutting or correctness-critical implementation",
    2,
    "codex",
    "high",
  ),
  investigator: roleSetting("Gather evidence and investigate questions", 4, "codex", "max"),
  reviewer: roleSetting("Strong read-only review and design guidance", 1, "codex", "xhigh"),
  writer: roleSetting(
    "Writes deliverables in the parent checkout with direct owner guidance",
    1,
    "claude",
    "high",
  ),
});

type LegacyRoleId = keyof typeof LegacyModelRoles.fields;
const legacyRoleIds = Object.keys(LegacyModelRoles.fields) as LegacyRoleId[];
const decodeLegacyModelRoles = Schema.decodeUnknownEffect(LegacyModelRoles);
const legacyDefaults = Schema.decodeSync(LegacyModelRoles)({});

const decodeLegacyRole = Schema.decodeUnknownOption(ModelRole);
const isEffort = Schema.is(ModelRoleEffort);

function migrateLegacyRoles(saved: readonly unknown[], workerProvider: unknown) {
  const roles: Partial<Record<LegacyRoleId, Partial<(typeof legacyDefaults)[LegacyRoleId]>>> = {};
  // Sprinter was the only default role with choices on both providers.
  if (workerProvider === "claude" || workerProvider === "codex") {
    roles["implementor-fast"] = { provider: workerProvider };
  }
  for (const entry of saved) {
    const role = Option.getOrUndefined(decodeLegacyRole(entry));
    if (role === undefined) continue;
    const id = legacyRoleIds.find((id) => id === role.id);
    if (id === undefined) continue;
    const claude = role.targets.find(
      (target) => target.providerInstanceId === TIER_PROVIDER_INSTANCES.claude,
    );
    const codex = role.targets.find(
      (target) => target.providerInstanceId === TIER_PROVIDER_INSTANCES.codex,
    );
    const provider =
      id !== "orchestrator" &&
      ((workerProvider === "claude" && claude) || (workerProvider === "codex" && codex))
        ? workerProvider
        : claude && codex
          ? "both"
          : claude
            ? "claude"
            : "codex";
    const choice =
      provider === "both"
        ? role.targets.find((target) => target === claude || target === codex)
        : provider === "claude"
          ? claude
          : codex;
    if (choice === undefined) continue;
    const choiceProvider = choice === claude ? "claude" : "codex";
    const tier = ModelTier.literals.find(
      (tier) => DEFAULT_MODEL_TIERS[tier][choiceProvider] === choice.model,
    );
    const effort = choice.options?.find(
      ({ id }) => id === TIER_PROVIDER_EFFORT_OPTIONS[choiceProvider],
    )?.value;
    roles[id] = {
      description: role.description,
      tier: tier ?? roles[id]?.tier ?? legacyDefaults[id].tier,
      provider,
      effort: isEffort(effort) ? effort : "default",
    };
  }
  return roles;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function migrateHandoffSetting(value: unknown) {
  if (!isRecord(value) || !Object.hasOwn(value, "orchestratorHandoffTokens")) return value;
  const { orchestratorHandoffTokens: tokens, ...settings } = value;
  if (!Object.hasOwn(settings, "orchestratorHandoffCompactions")) {
    if (tokens === null) settings.orchestratorHandoffCompactions = null;
    else if (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens > 0)
      settings.orchestratorHandoffCompactions = DEFAULT_ORCHESTRATOR_HANDOFF_COMPACTIONS;
  }
  return settings;
}

export function migrateForkPersistedHandoffSettings(value: unknown) {
  const settings = migrateHandoffSetting(value);
  if (!isRecord(settings) || !isRecord(settings.projectSettingsOverrides)) return settings;
  return {
    ...settings,
    projectSettingsOverrides: Object.fromEntries(
      Object.entries(settings.projectSettingsOverrides).map(([project, override]) => [
        project,
        migrateHandoffSetting(override),
      ]),
    ),
  };
}

function isLegacyRoleObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const hasLegacyRole = Object.keys(value).some(
    (id) =>
      id === "sprinter" ||
      (Object.hasOwn(LegacyModelRoles.fields, id) && !Object.hasOwn(ModelRoles.fields, id)),
  );
  if (hasLegacyRole) return true;
  const groups = Object.values(value).filter(isRecord);
  return groups.length > 0 && !groups.some((role) => "routine" in role || "complex" in role);
}

function foldLegacyRoles(legacy: typeof LegacyModelRoles.Type, stored: Record<string, unknown>) {
  const defaults = DEFAULT_SERVER_SETTINGS.modelRoles;
  const roles: Record<ThreadRole, Partial<Record<ModelRoleLevel, Record<string, unknown>>>> = {
    orchestrator: {},
    designer: {},
    implementor: {},
    reviewer: {},
    writer: {},
  };
  for (const id of legacyRoleIds) {
    const [role, level] = resolveModelRoleName(id)!;
    const setting =
      id === "implementor-fast" && legacy[id].description === legacyDefaults[id].description
        ? { ...legacy[id], description: defaults.implementor.routine.description }
        : legacy[id];
    const previous = stored[id];
    const baseline: Record<string, unknown> = defaults[role][level];
    // Equal defaults stay sparse unless the user explicitly saved the value.
    roles[role][level] = Object.fromEntries(
      Object.entries(setting).filter(
        ([key, value]) =>
          value !== baseline[key] || (isRecord(previous) && Object.hasOwn(previous, key)),
      ),
    );
  }
  for (const role of ["orchestrator", "writer"] as const) {
    const provider = roles[role].complex?.provider;
    if (provider !== undefined) roles[role].routine = { provider };
  }
  return roles;
}

export const migrateForkPersistedModelRoles = Effect.fn("serverSettings.migrateModelRoles")(
  function* (value: unknown) {
    if (!isRecord(value)) return value;
    const { modelRoles, workerProvider, ...saved } = value;
    const legacy =
      Array.isArray(modelRoles) || (modelRoles === undefined && workerProvider !== undefined)
        ? migrateLegacyRoles(Array.isArray(modelRoles) ? modelRoles : [], workerProvider)
        : isLegacyRoleObject(modelRoles)
          ? !Object.hasOwn(modelRoles, "implementor-fast") && Object.hasOwn(modelRoles, "sprinter")
            ? { ...modelRoles, "implementor-fast": modelRoles.sprinter }
            : modelRoles
          : undefined;
    if (legacy === undefined) return value;
    const decoded = yield* decodeLegacyModelRoles(legacy);
    return { ...saved, modelRoles: foldLegacyRoles(decoded, legacy) };
  },
);

export const migrateForkPersistedServerSettings = (
  saved: Omit<ServerSettings, "usageLimitRecovery"> & { readonly usageLimitRecovery?: unknown },
): ServerSettings => ({
  ...saved,
  usageLimitRecovery:
    saved.usageLimitRecovery === "off" ||
    saved.usageLimitRecovery === "wait" ||
    saved.usageLimitRecovery === "switch"
      ? saved.usageLimitRecovery
      : saved.autoResumeLimitedThreads || saved.snoozeLimitedThreads
        ? "wait"
        : "off",
});
