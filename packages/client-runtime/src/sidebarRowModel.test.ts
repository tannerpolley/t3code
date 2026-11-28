import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { sidebarRowModel, threadLifeRing } from "./sidebarRowModel.ts";

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

describe("thread life ring", () => {
  const shell = (compactionCount: number, contextFillPercent?: number) =>
    ({
      lineage: { parentThreadId: null },
      compactionCount,
      ...(contextFillPercent === undefined ? {} : { contextFillPercent }),
    }) as unknown as OrchestrationV2ThreadShell;

  it("fills with lifetime toward the compaction limit, not the context window", () => {
    expect(threadLifeRing(shell(2, 90), 4)).toEqual({
      count: 2,
      context: 90,
      fill: 73,
      warning: false,
    });
    expect(threadLifeRing(shell(0, 50), 4)?.fill).toBe(13);
  });

  it("is full and warns once the compaction limit is reached", () => {
    expect(threadLifeRing(shell(4, 10), 4)).toMatchObject({ fill: 100, warning: true });
    expect(threadLifeRing(shell(1), 4)?.fill).toBe(25);
  });
});
