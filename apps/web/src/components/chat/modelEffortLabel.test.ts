import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { modelEffortLabel } from "./modelEffortLabel";

const codexEffort: ProviderOptionDescriptor = {
  id: "reasoningEffort",
  label: "Reasoning effort",
  type: "select",
  options: [
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra high" },
  ],
};

describe("modelEffortLabel", () => {
  it("uses the provider's label for Codex and Claude effort options", () => {
    expect(modelEffortLabel([{ id: "reasoningEffort", value: "xhigh" }], [codexEffort])).toBe(
      "Extra high",
    );
    expect(modelEffortLabel([{ id: "effort", value: "max" }], [])).toBe("Max");
  });

  it("is null when the selection sets no effort", () => {
    expect(modelEffortLabel([{ id: "fastMode", value: true }], [codexEffort])).toBeNull();
    expect(modelEffortLabel(undefined, undefined)).toBeNull();
  });
});
