import type { ProviderOptionDescriptor, ProviderOptionSelection } from "@t3tools/contracts";

/** Codex and Grok call reasoning depth `reasoningEffort`; Claude calls it `effort`. */
const EFFORT_OPTION_IDS = new Set(["reasoningEffort", "effort"]);

/**
 * The effort a model selection runs at, as its provider labels it ("Max", "High"), or null when
 * the selection sets none. A value the provider no longer lists is shown capitalized.
 */
export function modelEffortLabel(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): string | null {
  const selection = options?.find((option) => EFFORT_OPTION_IDS.has(option.id));
  if (!selection || typeof selection.value !== "string") return null;
  const descriptor = descriptors?.find((candidate) => candidate.id === selection.id);
  const choice =
    descriptor?.type === "select"
      ? descriptor.options.find((option) => option.id === selection.value)
      : undefined;
  return choice?.label ?? selection.value.charAt(0).toUpperCase() + selection.value.slice(1);
}
