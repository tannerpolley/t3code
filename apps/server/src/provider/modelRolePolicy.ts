import {
  TIER_PROVIDERS,
  TIER_PROVIDER_INSTANCES,
  resolveModelRoleName,
  OrchestratorMcpFailure,
  type ModelRole,
  type ModelRoleLevel,
  type ModelRoleTarget,
  type OrchestratorMcpModelRole,
  type OrchestratorMcpProviderCredits,
  type OrchestratorMcpTarget,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  elapsedShare,
  paceOf,
  remainingPercent,
  usageWindowAppliesToModel,
} from "@t3tools/shared/usageLimits";
import { isUsageWindowStale } from "@t3tools/shared/forkUsageLimits";
import { offeredCodexServiceTier } from "@t3tools/shared/model";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { advertisedModel, checkDelegateTarget } from "../mcp/delegateTaskTarget.ts";

export function roleDefaultTarget(
  roles: ReadonlyArray<OrchestratorMcpModelRole>,
  requestedRole: string,
  requestedLevel: ModelRoleLevel | undefined,
  target: OrchestratorMcpTarget | undefined,
  driverFor: (id: ProviderInstanceId) => ProviderDriverKind | undefined,
): ModelRoleTarget | OrchestratorMcpFailure | undefined {
  const slot = resolveModelRoleName(requestedRole);
  if (slot === undefined) return undefined;
  const [threadRole, defaultLevel] = slot;
  const level = requestedLevel ?? defaultLevel;
  const matching = roles.filter(
    (entry) => (entry.role ?? resolveModelRoleName(entry.id)?.[0]) === threadRole,
  );
  const role =
    matching.find((entry) => (entry.level ?? resolveModelRoleName(entry.id)?.[1]) === level) ??
    matching[0];
  if (role === undefined) return undefined;
  const requestedOptions = target?.options;
  const choice = role.targets.find(
    ({ providerInstanceId, model, options }) =>
      (target?.providerInstanceId === undefined ||
        target.providerInstanceId === providerInstanceId) &&
      (target?.driverKind === undefined || target.driverKind === driverFor(providerInstanceId)) &&
      (target?.model === undefined || target.model === model) &&
      (requestedOptions === undefined ||
        (requestedOptions.length === (options?.length ?? 0) &&
          (options ?? []).every(({ id, value }) =>
            requestedOptions.some(
              (option) =>
                option.id === id &&
                (option.value === value ||
                  (id === "serviceTier" &&
                    driverFor(providerInstanceId) === "codex" &&
                    typeof value === "string" &&
                    typeof option.value === "string" &&
                    offeredCodexServiceTier([{ id: value }], option.value) === value)),
            ),
          ))),
  );
  if (choice === undefined) {
    const [current] = role.targets;
    return new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `The target is outside the current ${role.name} choices. The first choice is ${current.model} on ${current.providerInstanceId}${current.options?.length ? ` with ${current.options.map(({ id, value }) => `${id}=${value}`).join(", ")}` : ""}. Omit the model target fields to use the role's choice, or ask the owner through the question tool and set target.override to true after they approve.`,
    });
  }
  const { providerInstanceId, model, options, unavailableReason, weeklyUsage, creditsApproved } =
    choice;
  const reason =
    unavailableReason ??
    (weeklyUsage?.remainingPercent === 0 && !creditsApproved ? "Weekly usage is exhausted." : null);
  if (reason !== null) {
    return new OrchestratorMcpFailure({
      code: "provider_unavailable",
      message: `The ${role.name} role choice ${model} on ${providerInstanceId} is unavailable. ${reason} Ask the owner through the question tool before using another model. Offer the role's other choices with a recommendation and wait for the answer.`,
    });
  }
  return { providerInstanceId, model, ...(options === undefined ? {} : { options }) };
}

const MIN_WEEKLY_HEADROOM = 0.8;

export function providerCreditStatuses(
  providers: ReadonlyArray<ServerProvider>,
  approved: ServerSettings["providerCreditsApproved"],
  now: number,
): ReadonlyArray<OrchestratorMcpProviderCredits> {
  return TIER_PROVIDERS.map((id) => {
    const providerInstanceId = TIER_PROVIDER_INSTANCES[id];
    const limits = providers.find(
      (provider) => provider.instanceId === providerInstanceId,
    )?.usageLimits;
    const resetCreditCount = limits?.resetCredits?.availableCount;
    const credits = limits?.credits;
    const spend = limits?.windows.find((window) => window.id === "monthly_spend");
    const extraUsageRemainingPercent = limits?.zeroSpendCap
      ? 0
      : spend === undefined
        ? undefined
        : remainingPercent(spend);
    const monthlyCreditLimitReached =
      id === "codex" &&
      limits?.windows.some(
        (window) =>
          window.id === "individual" &&
          window.usedPercent >= 100 &&
          !isUsageWindowStale(window, now),
      );
    const creditsAvailable = monthlyCreditLimitReached
      ? false
      : credits?.hasCredits || credits?.unlimited || (extraUsageRemainingPercent ?? 0) > 0
        ? true
        : credits != null || extraUsageRemainingPercent !== undefined
          ? false
          : undefined;
    return {
      providerInstanceId,
      approved: approved[id],
      ...(resetCreditCount === undefined ? {} : { resetCreditCount }),
      ...(credits?.unlimited
        ? { balance: "unlimited" }
        : credits?.balance == null
          ? {}
          : { balance: credits.balance }),
      ...(extraUsageRemainingPercent === undefined ? {} : { extraUsageRemainingPercent }),
      ...(creditsAvailable === undefined ? {} : { creditsAvailable }),
    };
  });
}

/** Each role's choices with why `delegate_task` would reject each right now, or null. */
export function modelRoleStatuses(
  roles: ReadonlyArray<ModelRole>,
  providers: ReadonlyArray<ServerProvider>,
  orchestrationCapableInstanceIds: ReadonlySet<ProviderInstanceId>,
  now: number,
  providerCredits: ReadonlyArray<OrchestratorMcpProviderCredits> = [],
  order: "configured" | "weekly-headroom" = "configured",
): ReadonlyArray<OrchestratorMcpModelRole> {
  const providerById = new Map(providers.map((provider) => [provider.instanceId, provider]));
  return roles.map((role) => {
    const choices = Arr.map(role.targets, (target, configuredOrder) => {
      const checked = checkDelegateTarget({
        providers,
        orchestrationCapableInstanceIds,
        instanceId: target.providerInstanceId,
        requestedModel: target.model,
        inheritedModel: undefined,
        options: target.options,
      });
      const provider = providerById.get(target.providerInstanceId);
      const windows =
        provider === undefined ? [] : weeklyWindowsForModel(provider, target.model, now);
      const window = [...windows].sort(
        (left, right) => remainingPercent(left) - remainingPercent(right),
      )[0];
      const credits = providerCredits.find(
        (entry) => entry.providerInstanceId === target.providerInstanceId,
      );
      const creditsApproved = credits?.approved === true;
      const headroom = creditsApproved ? Infinity : modelWeeklyHeadroom(windows, now);
      const weeklyUsage =
        window === undefined
          ? undefined
          : {
              remainingPercent: remainingPercent(window),
              resetsAt: window.resetsAt ?? null,
              pace: paceOf(window, now),
            };
      const unavailableReason =
        typeof checked !== "string"
          ? checked.message
          : weeklyUsage?.remainingPercent === 0 &&
              (!creditsApproved || credits.creditsAvailable !== true)
            ? creditsApproved && credits.creditsAvailable === false
              ? "Weekly usage and credits are exhausted."
              : "Weekly usage is exhausted."
            : null;
      return {
        target: {
          ...target,
          unavailableReason,
          ...(creditsApproved ? { creditsApproved } : {}),
          ...(weeklyUsage === undefined ? {} : { weeklyUsage }),
        },
        configuredOrder,
        unavailable: unavailableReason !== null,
        headroom,
      };
    });
    const sortedChoices = Arr.sort(
      choices,
      Order.make<(typeof choices)[number]>((left, right) => {
        const rank = (choice: (typeof choices)[number]) =>
          choice.unavailable
            ? 2
            : order === "weekly-headroom" ||
                (choice.headroom !== undefined &&
                  choice.headroom + Number.EPSILON < MIN_WEEKLY_HEADROOM)
              ? 1
              : 0;
        const leftRank = rank(left);
        const byRank = Order.Number(leftRank, rank(right));
        if (byRank !== 0) return byRank;
        if (leftRank === 1) {
          const byHeadroom = Order.Number(right.headroom ?? -Infinity, left.headroom ?? -Infinity);
          if (byHeadroom !== 0) return byHeadroom;
        }
        return Order.Number(left.configuredOrder, right.configuredOrder);
      }),
    );
    return {
      ...role,
      targets: Arr.map(sortedChoices, ({ target }) => target),
    };
  });
}

function modelWeeklyHeadroom(
  windows: readonly ServerProviderUsageWindow[],
  now: number,
): number | undefined {
  const headrooms = windows.flatMap((window) => {
    const headroom = weeklyHeadroom(window, now);
    return headroom === undefined ? [] : [headroom];
  });
  return headrooms.length === 0 ? undefined : Math.min(...headrooms);
}

function weeklyHeadroom(window: ServerProviderUsageWindow, now: number): number | undefined {
  const elapsed = elapsedShare(window, now);
  if (elapsed === null) return undefined;
  return remainingPercent(window) / 100 / (1 - elapsed);
}

function weeklyWindowsForModel(
  provider: ServerProvider,
  model: string,
  now: number,
): readonly ServerProviderUsageWindow[] {
  const windows =
    provider.usageLimits?.windows.filter(
      (window) => window.kind === "weekly" && !isUsageWindowStale(window, now),
    ) ?? [];
  const canonicalModel = advertisedModel(provider, model)?.slug ?? model;
  const applicable = windows.filter((window) => usageWindowAppliesToModel(window, canonicalModel));
  if (provider.driver !== "claudeAgent") return applicable.slice(0, 1);

  const modelTerms = model
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part !== "claude" && !/^\d+$/.test(part));
  return applicable.filter((window) => {
    if (window.modelIds !== undefined || window.providerIds !== undefined) return true;
    // Older Claude readers report the model family only in the window name.
    if (window.id.toLowerCase() === "seven_day" || window.label.toLowerCase() === "weekly")
      return true;
    const windowTerms = `${window.id} ${window.label}`.toLowerCase().split(/[^a-z0-9]+/);
    return modelTerms.some((term) => windowTerms.includes(term));
  });
}
