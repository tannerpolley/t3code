import {
  effectiveThreadRole,
  resolveModelRoles,
  resolveThreadRole,
  type ModelRole,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { isUsageWindowStale } from "@t3tools/shared/forkUsageLimits";
import { modelRoleStatuses, providerCreditStatuses } from "../provider/modelRolePolicy.ts";

type UsageLimitThread = Pick<
  OrchestrationV2AppThread,
  "modelSelection" | "role" | "branch" | "worktreePath"
> & {
  readonly legacyRoutineRole?: boolean;
  readonly lineage: Pick<OrchestrationV2AppThread["lineage"], "relationshipToParent">;
};

/**
 * The thread's role (the same one the sidebar shows) picks the levels; within it, the level
 * matching the most options on the current selection wins, else its first one.
 */
export function usageLimitThreadRole(
  thread: UsageLimitThread,
  roles: readonly ModelRole[],
): ModelRole | undefined {
  const threadRole = effectiveThreadRole(thread);
  const owned = roles.filter((role) => (role.role ?? resolveThreadRole(role.id)) === threadRole);
  if (thread.legacyRoutineRole) {
    const routine = owned.find((role) => role.level === "routine");
    if (routine !== undefined) return routine;
  }
  const { instanceId, model, options } = thread.modelSelection;
  let matched = owned[0];
  let specificity = -1;
  for (const role of owned) {
    for (const target of role.targets) {
      const required = target.options ?? [];
      if (
        required.length > specificity &&
        target.providerInstanceId === instanceId &&
        target.model === model &&
        required.every(({ id, value }) =>
          options?.some((option) => option.id === id && option.value === value),
        )
      ) {
        matched = role;
        specificity = required.length;
      }
    }
  }
  return matched;
}

export function usageLimitSwitchTarget(
  thread: UsageLimitThread,
  settings: Pick<
    ServerSettings,
    "modelRoles" | "modelTiers" | "providerCreditsApproved" | "usageLimitFallbackModels"
  >,
  providers: readonly ServerProvider[],
  capableIds: ReadonlySet<ProviderInstanceId>,
  now: number,
  excludedTargetInstanceIds: ReadonlySet<ProviderInstanceId> = new Set(),
): ModelSelection | null {
  const source = providers.find(
    (provider) => provider.instanceId === thread.modelSelection.instanceId,
  );
  if (source?.driver !== "codex" && source?.driver !== "claudeAgent") return null;
  const role = usageLimitThreadRole(thread, resolveModelRoles(settings));
  // Reuse the role ranking and its model/option validation for fallback targets too.
  const fallbackTargets = settings.usageLimitFallbackModels.map((selection) => ({
    providerInstanceId: selection.instanceId,
    model: selection.model,
    ...(selection.options === undefined ? {} : { options: selection.options }),
  }));
  const first = fallbackTargets[0];
  const fallbackRole =
    first === undefined
      ? undefined
      : {
          id: "usage-limit-fallback",
          name: "Usage limit fallback",
          description: "",
          targets: [first, ...fallbackTargets.slice(1)] as const,
        };
  const ranked = modelRoleStatuses(
    [...(role === undefined ? [] : [role]), ...(fallbackRole === undefined ? [] : [fallbackRole])],
    providers,
    capableIds,
    now,
    providerCreditStatuses(providers, settings.providerCreditsApproved, now),
    "weekly-headroom",
  );
  const choice = ranked
    .flatMap((candidate) => candidate.targets)
    .find((target) => {
      const provider = providers.find(
        (provider) => provider.instanceId === target.providerInstanceId,
      );
      return (
        target.unavailableReason === null &&
        provider !== undefined &&
        !excludedTargetInstanceIds.has(target.providerInstanceId) &&
        (provider.driver === "codex" || provider.driver === "claudeAgent") &&
        provider.driver !== source.driver &&
        !provider.usageLimits?.windows.some(
          (window) =>
            window.kind !== "weekly" &&
            window.usedPercent >= 100 &&
            !isUsageWindowStale(window, now),
        )
      );
    });
  return choice === undefined
    ? null
    : {
        instanceId: choice.providerInstanceId,
        model: choice.model,
        ...(choice.options === undefined ? {} : { options: choice.options }),
      };
}
