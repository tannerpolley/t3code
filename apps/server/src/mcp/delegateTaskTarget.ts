import {
  isProviderAvailable,
  OrchestratorMcpFailure,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { offeredCodexServiceTier, withLegacyUltracodeEffort } from "@t3tools/shared/model";

export const advertisedModel = (provider: ServerProvider, model: string) =>
  provider.models.find((candidate) => candidate.slug === model) ??
  provider.models.find((candidate) =>
    candidate.aliases?.some((alias) => alias.toLowerCase() === model.toLowerCase()),
  );

export const LISTED_MODEL_LIMIT = 8;

/** Names advertised slugs to retry with: same last `/` segment first, else a short list. */
function advertisedModelsHint(models: ServerProvider["models"], requested: string) {
  const lastSegment = (slug: string) => slug.slice(slug.lastIndexOf("/") + 1).toLowerCase();
  const wanted = lastSegment(requested);
  const close = models.filter((model) => lastSegment(model.slug) === wanted);
  if (close.length > 0) {
    return `Did you mean ${close
      .slice(0, LISTED_MODEL_LIMIT)
      .map((model) => model.slug)
      .join(", ")}?`;
  }
  const listed = models
    .toSorted((a, b) => Number(a.isLegacy ?? false) - Number(b.isLegacy ?? false))
    .slice(0, LISTED_MODEL_LIMIT);
  const omitted = models.length - listed.length;
  return `Advertised models: ${listed.map((model) => model.slug).join(", ")}${
    omitted > 0 ? ` and ${omitted} more; orchestrator_capabilities with search finds them` : ""
  }.`;
}

const withV = (version: string) => (version.startsWith("v") ? version : `v${version}`);

export function unavailableModelMessage(provider: ServerProvider, model: string) {
  const updateRequired = provider.updateRequiredModels?.find(
    (candidate) => candidate.slug === model,
  );
  const detectedVersion = provider.installedVersion ?? provider.version;
  return updateRequired === undefined
    ? `Model ${model} is not advertised by provider ${provider.instanceId}. ${advertisedModelsHint(provider.models, model)}`
    : `Model ${model} needs provider ${provider.instanceId} at ${withV(updateRequired.minVersion)} or newer, but the detected CLI is ${detectedVersion === null ? "an unknown version" : withV(detectedVersion)}. Ask the user to update it or point the provider's binary path at a newer install.`;
}

export function providerConstraints(
  provider: ServerProvider | undefined,
  supportsOrchestrationV2: boolean,
): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!supportsOrchestrationV2) {
    constraints.push("No V2 provider adapter is registered.");
  }
  if (provider === undefined) return constraints;
  if (!isProviderAvailable(provider)) {
    constraints.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  }
  if (!provider.enabled) {
    constraints.push("Provider instance is disabled.");
    // Disabled snapshots contain placeholders for installation, health, and auth.
    return constraints;
  }
  if (!provider.installed) constraints.push("Provider executable is not installed.");
  if (provider.status === "error" || provider.status === "disabled") {
    constraints.push(provider.message ?? `Provider status is ${provider.status}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    constraints.push("Provider is not authenticated.");
  }
  return constraints;
}

/**
 * Checks option selections against the model's advertised descriptors, if any.
 * Duplicate ids always fail: consumers disagree on whether the first or last wins.
 */
function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
  driver: ProviderDriverKind,
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
    if (descriptor.type === "select") {
      const alias =
        driver === "codex" && descriptor.id === "serviceTier" && typeof selection.value === "string"
          ? offeredCodexServiceTier(descriptor.options, selection.value)
          : undefined;
      if (
        !descriptor.options.some((choice) => choice.id === selection.value || choice.id === alias)
      ) {
        const choices = descriptor.options.map((choice) => choice.id).join(", ");
        problems.push(`Option ${selection.id} must be one of: ${choices}.`);
      }
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
    advertisedModel(provider, requestedModel) === undefined
  ) {
    return fail("model_unavailable", unavailableModelMessage(provider, requestedModel));
  }
  if (input.options !== undefined) {
    const descriptors = advertisedModel(provider, model)?.capabilities?.optionDescriptors;
    const invalid = invalidOptionSelections(
      withLegacyUltracodeEffort(descriptors, input.options) ?? [],
      descriptors,
      provider.driver,
    );
    if (invalid.length > 0) {
      return fail(
        "invalid_request",
        `Model ${model} on provider ${instanceId} rejected options: ${invalid.join(" ")}`,
      );
    }
  }
  return model;
}
