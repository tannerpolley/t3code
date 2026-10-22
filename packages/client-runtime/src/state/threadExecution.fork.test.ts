import { describe, expect, it } from "vite-plus/test";

import { modelSelectionEffortLevel } from "./threadExecution.ts";

describe("modelSelectionEffortLevel", () => {
  it("places catalog labels and raw values on the five-step scale", () => {
    const levels = (labels: string[]) =>
      labels.map((label) => Object.values(modelSelectionEffortLevel(label)));
    expect(levels(["Low", "Medium", "High", "Extra High", "Maximum"])).toEqual([
      [1, "Low"],
      [2, "Medium"],
      [3, "High"],
      [4, "Extra high"],
      [5, "Max"],
    ]);
    expect(levels(["med", "xhigh", "extra_high", "max"])).toEqual([
      [2, "Medium"],
      [4, "Extra high"],
      [4, "Extra high"],
      [5, "Max"],
    ]);
    expect(levels(["Ultra", "Minimal"])).toEqual([
      [0, "Ultra"],
      [0, "Minimal"],
    ]);
  });
});
