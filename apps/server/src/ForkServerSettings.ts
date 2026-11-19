import {
  DEFAULT_MODEL_TIERS,
  DEFAULT_SERVER_SETTINGS,
  MODEL_ROLE_IDS,
  ModelRole,
  ModelRoleEffort,
  ModelRoles,
  ModelTier,
  type ServerSettings,
  TIER_PROVIDER_EFFORT_OPTIONS,
  TIER_PROVIDER_INSTANCES,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ForkPersistedServerSettingsFields = {
  usageLimitRecovery: Schema.optionalKey(Schema.Unknown),
  modelRoles: Schema.optionalKey(Schema.Union([ModelRoles, Schema.Array(Schema.Unknown)])),
  workerProvider: Schema.optionalKey(Schema.Unknown),
};

const decodeLegacyRole = Schema.decodeUnknownOption(ModelRole);
const isEffort = Schema.is(ModelRoleEffort);

function migrateLegacyRoles(saved: readonly unknown[], workerProvider: unknown) {
  const roles = { ...DEFAULT_SERVER_SETTINGS.modelRoles };
  // Sprinter was the only default role with choices on both providers.
  if (workerProvider === "claude" || workerProvider === "codex") {
    roles["implementor-fast"] = { ...roles["implementor-fast"], provider: workerProvider };
  }
  for (const entry of saved) {
    const role = Option.getOrUndefined(decodeLegacyRole(entry));
    if (role === undefined) continue;
    const id = MODEL_ROLE_IDS.find((id) => id === role.id);
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

export const migrateForkPersistedServerSettings = ({
  modelRoles,
  workerProvider,
  ...saved
}: Omit<ServerSettings, "usageLimitRecovery" | "modelRoles"> & {
  readonly usageLimitRecovery?: unknown;
  readonly modelRoles?: ServerSettings["modelRoles"] | readonly unknown[];
  readonly workerProvider?: unknown;
}): ServerSettings => ({
  ...saved,
  modelRoles:
    modelRoles !== undefined && "orchestrator" in modelRoles
      ? modelRoles
      : migrateLegacyRoles(modelRoles ?? [], workerProvider),
  usageLimitRecovery:
    saved.usageLimitRecovery === "off" ||
    saved.usageLimitRecovery === "wait" ||
    saved.usageLimitRecovery === "switch"
      ? saved.usageLimitRecovery
      : saved.autoResumeLimitedThreads || saved.snoozeLimitedThreads
        ? "wait"
        : "off",
});
