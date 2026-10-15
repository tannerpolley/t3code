import {
  effectiveThreadRole,
  resolveThreadRole,
  type ModelRole,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { isUsageWindowStale } from "@t3tools/shared/forkUsageLimits";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { modelRoleStatuses } from "../mcp/delegateTaskTarget.ts";

type UsageLimitThread = Pick<
  OrchestrationV2AppThread,
  "modelSelection" | "role" | "branch" | "worktreePath"
> & {
  readonly lineage: Pick<OrchestrationV2AppThread["lineage"], "relationshipToParent">;
};

/**
 * The thread's role (the same one the sidebar shows) picks the profiles; within it, the profile
 * listing the current selection wins, else its first one. Implementor profiles live in settings.
 */
export function usageLimitThreadRole(
  thread: UsageLimitThread,
  roles: readonly ModelRole[],
): ModelRole | undefined {
  const threadRole = effectiveThreadRole(thread);
  const owned = roles.filter((role) => (role.role ?? resolveThreadRole(role.id)) === threadRole);
  const matched = owned.find((role) =>
    role.targets.some((target) =>
      modelSelectionsEqual(thread.modelSelection, {
        instanceId: target.providerInstanceId,
        model: target.model,
        ...(target.options === undefined ? {} : { options: target.options }),
      }),
    ),
  );
  return matched ?? owned[0];
}

export function usageLimitSwitchTarget(
  thread: UsageLimitThread,
  settings: Pick<ServerSettings, "modelRoles" | "usageLimitFallbackModels">,
  providers: readonly ServerProvider[],
  capableIds: ReadonlySet<ProviderInstanceId>,
  now: number,
  excludedTargetInstanceIds: ReadonlySet<ProviderInstanceId> = new Set(),
): ModelSelection | null {
  const source = providers.find(
    (provider) => provider.instanceId === thread.modelSelection.instanceId,
  );
  if (source?.driver !== "codex" && source?.driver !== "claudeAgent") return null;
  const role = usageLimitThreadRole(thread, settings.modelRoles);
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
        target.weeklyUsage?.remainingPercent !== 0 &&
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
