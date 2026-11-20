import {
  DEFAULT_MODEL_TIERS,
  DEFAULT_SERVER_SETTINGS,
  ModelRole,
  ModelRoleEffort,
  ModelRoleProvider,
  resolveModelRoleName,
  ModelRoles,
  ModelTier,
  type ServerSettings,
  TIER_PROVIDER_EFFORT_OPTIONS,
  TIER_PROVIDER_INSTANCES,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ForkPersistedServerSettingsFields = {
  usageLimitRecovery: Schema.optionalKey(Schema.Unknown),
  modelRoles: Schema.optionalKey(Schema.Unknown),
  workerProvider: Schema.optionalKey(Schema.Unknown),
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

const legacyRoleIds = Object.keys(LegacyModelRoles.fields) as Array<
  keyof typeof LegacyModelRoles.fields
>;
const decodeLegacyModelRoles = Schema.decodeUnknownEffect(LegacyModelRoles);
const decodeModelRoles = Schema.decodeUnknownEffect(ModelRoles);
const legacyDefaults = Schema.decodeSync(LegacyModelRoles)({});

const decodeLegacyRole = Schema.decodeUnknownOption(ModelRole);
const isEffort = Schema.is(ModelRoleEffort);

function migrateLegacyRoles(saved: readonly unknown[], workerProvider: unknown) {
  const roles = { ...legacyDefaults };
  // Sprinter was the only default role with choices on both providers.
  if (workerProvider === "claude" || workerProvider === "codex") {
    roles["implementor-fast"] = { ...roles["implementor-fast"], provider: workerProvider };
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
      tier: tier ?? roles[id].tier,
      provider,
      effort: isEffort(effort) ? effort : "default",
    };
  }
  return roles;
}

function isLegacyRoleObject(value: unknown) {
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([id, role]) =>
      id === "implementor-fast" ||
      id === "implementor-thorough" ||
      id === "checker" ||
      id === "investigator" ||
      (role !== null &&
        typeof role === "object" &&
        Object.keys(role).some((key) => key !== "routine" && key !== "complex")),
  );
}

function foldLegacyRoles(legacy: typeof LegacyModelRoles.Type): ServerSettings["modelRoles"] {
  const defaults = DEFAULT_SERVER_SETTINGS.modelRoles;
  const roles = {
    orchestrator: { ...defaults.orchestrator },
    designer: { ...defaults.designer },
    implementor: { ...defaults.implementor },
    reviewer: { ...defaults.reviewer },
    writer: { ...defaults.writer },
  };
  for (const id of legacyRoleIds) {
    const [role, level] = resolveModelRoleName(id)!;
    const setting = legacy[id];
    roles[role][level] =
      id === "implementor-fast" && setting.description === legacyDefaults[id].description
        ? { ...setting, description: defaults.implementor.routine.description }
        : setting;
  }
  for (const role of ["orchestrator", "writer"] as const) {
    roles[role].routine = { ...roles[role].routine, provider: roles[role].complex.provider };
  }
  return roles;
}

export const migrateForkPersistedServerSettings = ({
  modelRoles,
  workerProvider,
  ...saved
}: Omit<ServerSettings, "usageLimitRecovery" | "modelRoles"> & {
  readonly usageLimitRecovery?: unknown;
  readonly modelRoles?: unknown;
  readonly workerProvider?: unknown;
}) => {
  const roles =
    Array.isArray(modelRoles) || (modelRoles === undefined && workerProvider !== undefined)
      ? Effect.succeed(
          foldLegacyRoles(
            migrateLegacyRoles(Array.isArray(modelRoles) ? modelRoles : [], workerProvider),
          ),
        )
      : isLegacyRoleObject(modelRoles)
        ? Effect.map(decodeLegacyModelRoles(modelRoles), foldLegacyRoles)
        : decodeModelRoles(modelRoles === undefined ? {} : modelRoles);
  return Effect.map(roles, (modelRoles): ServerSettings => ({
    ...saved,
    modelRoles,
    usageLimitRecovery:
      saved.usageLimitRecovery === "off" ||
      saved.usageLimitRecovery === "wait" ||
      saved.usageLimitRecovery === "switch"
        ? saved.usageLimitRecovery
        : saved.autoResumeLimitedThreads || saved.snoozeLimitedThreads
          ? "wait"
          : "off",
  }));
};
