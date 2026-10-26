import {
  isProviderAvailable,
  type ModelRole,
  type ModelRoleTarget,
  resolveThreadRole,
  OrchestratorMcpFailure,
  type OrchestratorMcpModelRole,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerSettings,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { elapsedShare, paceOf, remainingPercent } from "@t3tools/shared/usageLimits";
import { isUsageWindowStale } from "@t3tools/shared/forkUsageLimits";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

export function providerConstraints(
  provider: ServerProvider | undefined,
  supportsOrchestrationV2: boolean,
): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!supportsOrchestrationV2) {
    constraints.push("No V2 provider adapter is registered.");
  }
  if (provider === undefined) return constraints;
  if (!provider.enabled) constraints.push("Provider instance is disabled.");
  if (!provider.installed) constraints.push("Provider executable is not installed.");
  if (!isProviderAvailable(provider)) {
    constraints.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  }
  if (provider.status === "error" || provider.status === "disabled") {
    constraints.push(provider.message ?? `Provider status is ${provider.status}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    constraints.push("Provider is not authenticated.");
  }
  return constraints;
}

/**
 * Checks requested option selections for duplicates and, when the model
 * advertises option descriptors, against those descriptors. Models without
 * descriptors skip the descriptor checks (mirroring how model slugs are only
 * validated when the provider advertises models), but duplicate ids always
 * fail: downstream consumers disagree on whether the first or last value of
 * a duplicated id wins.
 */
function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      problems.push(`Option ${selection.id} was specified more than once.`);
      continue;
    }
    seen.add(selection.id);
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${selection.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      problems.push(`Option ${selection.id} expects a boolean value.`);
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options.some((choice) => choice.id === selection.value)
    ) {
      const choices = descriptor.options.map((choice) => choice.id).join(", ");
      problems.push(`Option ${selection.id} must be one of: ${choices}.`);
    }
  }
  return problems;
}

/**
 * The model a `delegate_task` target resolves to on `instanceId`, or why
 * delegation would reject it. Without a requested model, the child inherits
 * `inheritedModel`, else the provider's first model.
 */
export function checkDelegateTarget(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly orchestrationCapableInstanceIds: ReadonlySet<ProviderInstanceId>;
  readonly instanceId: ProviderInstanceId;
  readonly requestedDriver?: ProviderDriverKind | undefined;
  readonly requestedModel: string | undefined;
  readonly inheritedModel: string | undefined;
  readonly options: ReadonlyArray<ProviderOptionSelection> | undefined;
}): string | OrchestratorMcpFailure {
  const { instanceId, requestedModel } = input;
  const fail = (code: OrchestratorMcpFailure["code"], message: string) =>
    new OrchestratorMcpFailure({ code, message });
  const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
  if (provider === undefined) {
    return fail("provider_unavailable", `Provider instance ${instanceId} is not registered.`);
  }
  if (input.requestedDriver !== undefined && provider.driver !== input.requestedDriver) {
    return fail(
      "invalid_request",
      `Provider instance ${instanceId} uses driver ${provider.driver}, not ${input.requestedDriver}.`,
    );
  }
  const constraints = providerConstraints(
    provider,
    input.orchestrationCapableInstanceIds.has(provider.instanceId),
  );
  if (constraints.length > 0) {
    return fail(
      "provider_unavailable",
      `Provider ${instanceId} cannot run a child task: ${constraints.join(" ")}`,
    );
  }
  const model = requestedModel ?? input.inheritedModel ?? provider.models[0]?.slug;
  if (model === undefined) {
    return fail(
      "model_unavailable",
      `Provider ${instanceId} has no model available for inheritance.`,
    );
  }
  if (
    requestedModel !== undefined &&
    provider.models.length > 0 &&
    !provider.models.some((candidate) => candidate.slug === requestedModel)
  ) {
    return fail(
      "model_unavailable",
      `Model ${requestedModel} is not advertised by provider ${instanceId}.`,
    );
  }
  if (input.options !== undefined) {
    const descriptors = provider.models.find((candidate) => candidate.slug === model)?.capabilities
      ?.optionDescriptors;
    const invalid = invalidOptionSelections(input.options, descriptors);
    if (invalid.length > 0) {
      return fail(
        "invalid_request",
        `Model ${model} on provider ${instanceId} rejected options: ${invalid.join(" ")}`,
      );
    }
  }
  return model;
}

export function workerProviderTargets<T extends ModelRoleTarget>(
  role: Pick<ModelRole, "id" | "role"> & { readonly targets: readonly [T, ...T[]] },
  providers: ReadonlyArray<ServerProvider>,
  workerProvider: ServerSettings["workerProvider"],
  isAvailable: (target: T) => boolean,
): readonly [T, ...T[]] {
  if (workerProvider === "mixed" || (role.role ?? resolveThreadRole(role.id)) === "orchestrator")
    return role.targets;
  const driver = workerProvider === "claude" ? "claudeAgent" : "codex";
  const matching = role.targets.filter(
    (target) =>
      providers.some(
        (provider) =>
          provider.instanceId === target.providerInstanceId && provider.driver === driver,
      ) && isAvailable(target),
  );
  const [first, ...rest] = matching;
  return first === undefined ? role.targets : [first, ...rest];
}

const MIN_WEEKLY_HEADROOM = 0.8;

/** Each role's choices with why `delegate_task` would reject each right now, or null. */
export function modelRoleStatuses(
  roles: ReadonlyArray<ModelRole>,
  providers: ReadonlyArray<ServerProvider>,
  orchestrationCapableInstanceIds: ReadonlySet<ProviderInstanceId>,
  now: number,
  workerProvider: ServerSettings["workerProvider"] = "mixed",
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
      const headroom =
        provider === undefined ? undefined : modelWeeklyHeadroom(provider, target.model, now);
      const weeklyUsage =
        window === undefined
          ? undefined
          : {
              remainingPercent: remainingPercent(window),
              resetsAt: window.resetsAt ?? null,
              pace: paceOf(window, now),
            };
      return {
        target: {
          ...target,
          unavailableReason: typeof checked === "string" ? null : checked.message,
          ...(weeklyUsage === undefined ? {} : { weeklyUsage }),
        },
        configuredOrder,
        unavailable: typeof checked !== "string",
        headroom,
      };
    });
    const sortedChoices = Arr.sort(
      choices,
      Order.make<(typeof choices)[number]>((left, right) => {
        const rank = (choice: (typeof choices)[number]) =>
          choice.unavailable
            ? 2
            : choice.headroom !== undefined && choice.headroom + Number.EPSILON < MIN_WEEKLY_HEADROOM
              ? 1
              : 0;
        const byAvailability = rank(left) - rank(right);
        if (byAvailability !== 0) return byAvailability < 0 ? -1 : 1;
        if (
          rank(left) === 1 &&
          left.headroom !== undefined &&
          right.headroom !== undefined &&
          left.headroom !== right.headroom
        ) {
          return left.headroom > right.headroom ? -1 : 1;
        }
        return left.configuredOrder < right.configuredOrder
          ? -1
          : left.configuredOrder > right.configuredOrder
            ? 1
            : 0;
      }),
    );
    return {
      ...role,
      targets: workerProviderTargets(
        { ...role, targets: Arr.map(sortedChoices, ({ target }) => target) },
        providers,
        workerProvider,
        (target) => target.unavailableReason === null,
      ),
    };
  });
}

export function modelWeeklyHeadroom(
  provider: ServerProvider,
  model: string,
  now: number,
): number | undefined {
  const headrooms = weeklyWindowsForModel(provider, model, now).flatMap((window) => {
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
  if (provider.driver !== "claudeAgent") return windows.slice(0, 1);

  const modelTerms = model
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part !== "claude" && !/^\d+$/.test(part));
  return windows.filter((window) => {
    if (window.id.toLowerCase() === "seven_day" || window.label.toLowerCase() === "weekly")
      return true;
    const windowTerms = `${window.id} ${window.label}`.toLowerCase().split(/[^a-z0-9]+/);
    return modelTerms.some((term) => windowTerms.includes(term));
  });
}
