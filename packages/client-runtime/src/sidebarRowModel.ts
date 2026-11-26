import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderOptionDescriptor,
  ServerProvider,
} from "@t3tools/contracts";
import { getProviderOptionStatedValue } from "@t3tools/shared/model";
import { msg } from "gt-i18n";
import { getDescriptorStringValue, isReasoningSelect } from "./modelTraits.ts";
import { getTriggerDisplayModelName } from "./providerModelDisplay.ts";

function sidebarModelParts(label: string) {
  const leading = /^(?:gpt-)?(\d+(?:\.\d+)*)[ -]+(.+)$/i.exec(label);
  if (leading) {
    const name = leading[2]!;
    return { name: name[0]!.toUpperCase() + name.slice(1), version: leading[1] };
  }
  const versioned = /^(.*?)[ -]+(\d+(?:[.-]\d+)*)(?:[ -]+(.*))?$/.exec(label);
  return versioned
    ? {
        name: [versioned[1], versioned[3]].filter(Boolean).join(" "),
        version: versioned[2]!.replaceAll("-", "."),
      }
    : { name: label };
}

export const sidebarRoleLabels = {
  implementation: msg("Implementor"),
  review: msg("Reviewer"),
  design: msg("Designer"),
  writer: msg("Writer"),
  research: msg("Researcher"),
  test: msg("Tester"),
};

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

// Older servers offer Ultracode as a level. It changes the workflow, so it keeps its name.
// Max and Ultra sit above the bar scale. Default leaves the level to the agent.
const NAMED_LEVELS = new Set(["ultracode", "max", "default", "ultra"]);
const OFF_LEVELS = new Set(["off", "none"]);
// More bars than this no longer fit the glyph's height in whole pixels.
const MAX_BARS = 7;

/**
 * Maps a reasoning select to bars: one per ordinary level, filled up to the current one, with an
 * off level as none filled. Max, Default, Ultra, prompt-injected and workflow levels keep their names.
 */
export function resolveEffortGlyph(descriptor: SelectDescriptor, current: string | null) {
  const special = new Set([...(descriptor.promptInjectedValues ?? []), ...NAMED_LEVELS]);
  const levels = descriptor.options.filter((option) => !special.has(option.id));
  if (levels.length < 2 || levels.length > MAX_BARS || current === null) return null;
  const startsAtOff = OFF_LEVELS.has(levels[0]!.id);
  const count = startsAtOff ? levels.length - 1 : levels.length;
  if (special.has(current)) {
    const label = descriptor.options.find((option) => option.id === current)?.label ?? current;
    return { count, filled: count, special: label, label };
  }
  const index = levels.findIndex((option) => option.id === current);
  if (index < 0) return null;
  return {
    count,
    filled: startsAtOff ? index : index + 1,
    special: null,
    label: levels[index]!.label,
  };
}

/** Bar heights that rise by one whole-pixel step, from about half height up to `maxBar`. */
export function effortBarHeights(count: number, maxBar: number): number[] {
  // Rounding each bar separately mixes 1px and 2px steps, so round the step once.
  const step = Math.max(1, Math.round(maxBar / 2 / Math.max(count - 1, 1)));
  return Array.from({ length: count }, (_, index) => maxBar - (count - 1 - index) * step);
}

export function sidebarRowModel(
  selection: ModelSelection,
  selectedModel: ServerProvider["models"][number] | undefined,
  driver: ProviderDriverKind | null | undefined,
) {
  const modelLabel = selectedModel
    ? getTriggerDisplayModelName(selectedModel, driver)
    : selection.model;
  const reasoning = selectedModel?.capabilities?.optionDescriptors?.find(isReasoningSelect);
  const statedEffort = reasoning
    ? getProviderOptionStatedValue(reasoning.id, selection)
    : undefined;
  const effort = reasoning
    ? resolveEffortGlyph(
        reasoning,
        typeof statedEffort === "string"
          ? statedEffort
          : getDescriptorStringValue(reasoning, selection),
      )
    : null;
  return { modelLabel, modelParts: sidebarModelParts(modelLabel), effort };
}
