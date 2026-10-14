import { describe, expect, it } from "@effect/vitest";

import {
  nearestInterfaceZoom,
  stepInterfaceZoom,
  zoomFactorToLevel,
  zoomLevelToFactor,
} from "./interfaceZoom.ts";

describe("interface zoom", () => {
  it("steps through the list and stops at both ends", () => {
    expect(stepInterfaceZoom(1, "in")).toBe(1.1);
    expect(stepInterfaceZoom(1, "out")).toBe(0.9);
    expect(stepInterfaceZoom(2, "in")).toBe(2);
    expect(stepInterfaceZoom(0.8, "out")).toBe(0.8);
  });

  it("moves off an off-list value to the next step in that direction", () => {
    // 1.2 is where the old half-level shortcut steps landed.
    expect(stepInterfaceZoom(1.2, "in")).toBe(1.25);
    expect(stepInterfaceZoom(1.2, "out")).toBe(1.1);
  });

  it("snaps to the nearest step", () => {
    expect(nearestInterfaceZoom(1.19)).toBe(1.25);
    expect(nearestInterfaceZoom(1.04)).toBe(1);
  });

  it("converts between Chromium zoom levels and factors", () => {
    expect(zoomLevelToFactor(zoomFactorToLevel(1.5))).toBeCloseTo(1.5);
    expect(zoomFactorToLevel(1)).toBe(0);
  });
});
