// @effect-diagnostics nodeBuiltinImport:off - compares generated CSS with the committed file on disk.
import * as NodeFS from "node:fs";
import { formatElapsedSeconds } from "../../timestampFormat";
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
    expect(optionalColumns(24)).toEqual(["model"]);
    expect(optionalColumns(27)).toEqual(["model", "effort"]);
    expect(optionalColumns(29)).toEqual(["model", "effort", "usage"]);
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

it("fits every elapsed label up to 99h 59m 59s inside the time track", () => {
  // Widest OpenDyslexic advances, in 2048ths of the 11px time size, across the installed OTF and
  // WOFF builds. The widest digit (1390) bounds every digit, as tabular numerals.
  const advances = new Map(Object.entries({ " ": 801, h: 1290, m: 1985, s: 1174 }));
  // Hours past 99 grow a digit and may spill; that is over four days on one turn.
  const samples = [0, 9, 59, 60, 309, 59 * 60 + 59, 3600, 3909, 10 * 3600, 99 * 3600 + 3599];
  for (const label of samples.map(formatElapsedSeconds)) {
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
