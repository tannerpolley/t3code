import { describe, expect, it } from "vite-plus/test";
import { sidebarColumnBudget } from "./SidebarColumns.layout";

// The local font's measured zero advance at 11px is 1337/2048*11 px.
const ch = 7.18115234375;
const optionalColumns = (sidebarRem: number) => {
  const container = sidebarRem * 16 - 40;
  const hidden = new Set<string>();
  for (const column of ["usage", "effort", "model"]) {
    const budget = sidebarColumnBudget(hidden);
    if (container < budget.rem * 16 + budget.px + budget.ch * ch) hidden.add(column);
  }
  return ["model", "effort", "usage"].filter((column) => !hidden.has(column));
};

describe("sidebar width budget", () => {
  it("protects ten title characters before admitting optional columns", () => {
    expect(optionalColumns(16)).toEqual([]);
    expect(optionalColumns(20)).toEqual(["model"]);
    expect(optionalColumns(24)).toEqual(["model", "effort", "usage"]);
    expect(optionalColumns(28)).toEqual(["model", "effort", "usage"]);
    const basic = sidebarColumnBudget(new Set(["usage", "effort", "model"]));
    expect(216 - basic.rem * 16 - basic.px).toBeGreaterThanOrEqual(10 * ch);
  });
});
