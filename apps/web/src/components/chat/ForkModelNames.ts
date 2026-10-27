import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { resolveModelShortName } from "@t3tools/client-runtime/provider-clients";
import type { ProviderDriverKind } from "@t3tools/contracts";
import {
  getDisplayModelName,
  getTriggerDisplayModelName,
  type ModelEsque,
} from "./providerIconUtils";

export const shortModelName = (name: string) => resolveModelShortName({ name }, undefined) ?? name;

export const forkTriggerDisplayModelName = (
  model: ModelEsque,
  driver: ProviderDriverKind | null | undefined,
  short: boolean,
) => (short ? getTriggerDisplayModelName(model, driver) : getDisplayModelName(model));

export function resolveForkSubagentMetadata(input: Parameters<typeof resolveSubagentMetadata>[0]) {
  const metadata = resolveSubagentMetadata(input);
  const slug = input.provider
    ? resolveSelectableModel(input.provider.driver, input.model, input.provider.models)
    : input.model;
  const catalogModel = input.provider?.models.find((model) => model.slug === slug);
  return catalogModel
    ? { ...metadata, modelLabel: getDisplayModelName(catalogModel, { preferShortName: true }) }
    : metadata;
}
