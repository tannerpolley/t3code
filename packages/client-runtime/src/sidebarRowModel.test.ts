import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { sidebarRowModel } from "./sidebarRowModel.ts";

const selection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const codex = ProviderDriverKind.make("codex");
const model = {
  slug: selection.model,
  name: selection.model,
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "serviceTier",
        label: "Service Tier",
        type: "select",
        options: [
          { id: "default", label: "Standard", isDefault: true },
          { id: "priority", label: "Fast" },
          { id: "ultrafast", label: "Ultrafast" },
        ],
      },
    ],
  },
} satisfies ServerProviderModel;

describe("sidebar row speed", () => {
  it.each([
    { options: [], speed: "standard" },
    { options: [{ id: "serviceTier", value: "priority" }], speed: "fast" },
    { options: [{ id: "serviceTier", value: "ultrafast" }], speed: "ultrafast" },
    { options: [{ id: "fastMode", value: true }], speed: "fast" },
    { options: [{ id: "fastMode", value: false }], speed: "standard" },
  ])("shows $speed for $options", ({ options, speed }) => {
    expect(sidebarRowModel({ ...selection, options }, model, codex).speed).toBe(speed);
  });

  it("uses the server's Codex default speed only when the thread leaves its tier unset", () => {
    expect(sidebarRowModel(selection, model, codex, "ultrafast").speed).toBe("ultrafast");
    const options = [{ id: "serviceTier", value: "default" }];
    expect(sidebarRowModel({ ...selection, options }, model, codex, "fast").speed).toBe("standard");
  });

  it("keeps a saved tier visible before the provider catalog loads", () => {
    const options = [{ id: "serviceTier", value: "priority" }];
    expect(sidebarRowModel({ ...selection, options }, undefined, undefined).speed).toBe("fast");
  });
});
