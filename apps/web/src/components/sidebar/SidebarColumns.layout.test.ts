// @effect-diagnostics nodeBuiltinImport:off - compares generated CSS with the committed file on disk.
import * as NodeFS from "node:fs";
import { formatCompactElapsedSeconds } from "../../timestampFormat";
import { describe, expect, it } from "vite-plus/test";
import {
  generateSidebarColumnLayoutCss,
  sidebarColumnBudget,
  sidebarColumnLayout,
} from "./SidebarColumns.layout";

// Local OpenDyslexic font metrics: zero advances 1337 of 2048 units.
const ch = (1337 / 2048) * sidebarColumnLayout.titleFontRem * 16;
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

it("keeps the committed CSS equal to generated CSS apart from formatter whitespace", () => {
  const committedCss = NodeFS.readFileSync(
    new URL("./SidebarColumns.layout.css", import.meta.url),
    "utf8",
  );
  const tokens = (css: string) => css.replace(/\s+/g, "");
  expect(tokens(committedCss)).toBe(tokens(generateSidebarColumnLayoutCss()));
});

it("fits every compact duration, including the longest labels, inside the time track", () => {
  // Measured OpenDyslexic advances at the time label's 11px size. Use the
  // widest digit (1390 units) as a conservative bound for tabular numerals.
  const units = { ".": 603, s: 1174, m: 1940, h: 1290, d: 1327, y: 1429, ">": 1629 };
  const advances = new Map(Object.entries(units));
  const samples = [
    0,
    59,
    60,
    59 * 60,
    60 * 60,
    90 * 60,
    599 * 60,
    600 * 60,
    999 * 3600,
    1000 * 3600,
    999 * 86400,
    1000 * 86400,
    9.9 * 365 * 86400,
    999 * 365 * 86400,
    1000 * 365 * 86400,
    Number.MAX_SAFE_INTEGER,
  ];
  const labels = samples.map(formatCompactElapsedSeconds);
  expect(Math.max(...labels.map((label) => label.length))).toBe(4);
  for (const label of labels) {
    const width =
      ([...label].reduce(
        (total, char) => total + (/\d/.test(char) ? 1390 : advances.get(char)!),
        0,
      ) /
        2048) *
      11;
    expect(width, label).toBeLessThanOrEqual(sidebarColumnLayout.tracks.time * 16);
  }
});
