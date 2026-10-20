// @effect-diagnostics nodeBuiltinImport:off - compares generated CSS with the committed file on disk.
import * as NodeFS from "node:fs";
import { formatElapsedSeconds } from "../../timestampFormat";
import { describe, expect, it } from "vite-plus/test";
import {
  generateSidebarColumnLayoutCss,
  sidebarColumnBudget,
  sidebarColumnLayout,
} from "./SidebarColumns.layout";

// Headless Chrome, installed OpenDyslexic Bold WOFF: 1ch = 8px at the 12px row font.
const ch = (8 / 12) * sidebarColumnLayout.titleFontRem * 16;
const optionalColumns = (sidebarRem: number, roleDisplay: "name" | "icon" = "name") => {
  const container = sidebarRem * 16 - 40;
  const hidden = new Set<string>();
  for (const group of sidebarColumnLayout.dropOrder) {
    const budget = sidebarColumnBudget(hidden, roleDisplay);
    if (container < budget.rem * 16 + budget.px + budget.ch * ch)
      for (const column of group) hidden.add(column);
  }
  return ["model", "effort", "issue"].filter((column) => !hidden.has(column));
};
/** Title width left in a row once every optional column has dropped. */
const minimumTitlePx = (sidebarRem: number) => {
  const all = new Set(sidebarColumnLayout.dropOrder.flat());
  const budget = sidebarColumnBudget(all);
  return (
    sidebarRem * 16 -
    40 -
    (budget.rem * 16 + budget.px + (budget.ch - sidebarColumnLayout.titleCh) * ch)
  );
};

describe("sidebar width budget", () => {
  it("budgets for the full role name before admitting optional columns", () => {
    expect(optionalColumns(16)).toEqual([]);
    expect(optionalColumns(23.8)).toEqual([]);
    expect(optionalColumns(24)).toEqual(["issue"]);
    expect(optionalColumns(28)).toEqual(["issue"]);
    expect(optionalColumns(28.5)).toEqual(["model", "issue"]);
    expect(optionalColumns(30.8)).toEqual(["model", "issue"]);
    expect(optionalColumns(31.1)).toEqual(["model", "effort", "issue"]);
  });

  it("admits optional columns sooner with role icons, keeping room for short command labels", () => {
    expect(optionalColumns(21.3, "icon")).toEqual([]);
    expect(optionalColumns(21.6, "icon")).toEqual(["issue"]);
    expect(optionalColumns(25.7, "icon")).toEqual(["issue"]);
    expect(optionalColumns(26, "icon")).toEqual(["model", "issue"]);
    expect(optionalColumns(28.6, "icon")).toEqual(["model", "effort", "issue"]);
    for (const rem of [21.6, 26, 28.6]) {
      expect(optionalColumns(rem, "icon").length).toBeGreaterThan(optionalColumns(rem).length);
    }
  });

  it("never overflows the default 16rem sidebar once every optional column has dropped", () => {
    expect(minimumTitlePx(16)).toBeGreaterThan(0);
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

// Widest OpenDyslexic advances, in 2048ths of the font size, across the installed Regular and Bold
// OTF and WOFF builds; this machine renders the sans font as OpenDyslexic Bold. The widest digit
// (1391) bounds every digit, as tabular numerals.
const ADVANCES = new Map(
  Object.entries({
    " ": 801,
    ".": 603,
    A: 1710,
    G: 1614,
    H: 1477,
    L: 1270,
    M: 1772,
    O: 1688,
    P: 1340,
    S: 1373,
    T: 1575,
    X: 1663,
    a: 1258,
    d: 1327,
    e: 1334,
    g: 1328,
    h: 1290,
    i: 551,
    k: 1387,
    l: 700,
    m: 1985,
    n: 1319,
    o: 1334,
    p: 1360,
    r: 979,
    s: 1174,
    t: 1027,
    u: 1260,
    w: 1803,
    x: 1512,
  }),
);
/** A label's width at a font size in px. */
const widthPx = (label: string, sizePx: number) =>
  ([...label].reduce((total, char) => total + (/\d/.test(char) ? 1391 : ADVANCES.get(char)!), 0) /
    2048) *
  sizePx;
const fits = (labels: readonly string[], sizePx: number, trackPx: number) => {
  for (const label of labels) expect(widthPx(label, sizePx), label).toBeLessThanOrEqual(trackPx);
};
const { tracks } = sidebarColumnLayout;

it("fits every elapsed label up to ten days inside the time track", () => {
  // From 100 hours the label switches to days, so hours never grow a third digit; two-digit days
  // overrun the track by a fraction of a pixel.
  const day = 24 * 3600;
  const samples = [0, 9, 59, 60, 309, 59 * 60 + 59, 3600, 3909, 10 * 3600, 99 * 3600 + 3599];
  fits(
    [...samples, 100 * 3600, 141 * 3600 + 1330, 9 * day + 23 * 3600 + 3599].map(
      formatElapsedSeconds,
    ),
    10,
    tracks.time * 16,
  );
  expect(formatElapsedSeconds(141 * 3600 + 22 * 60 + 10)).toBe("5d 21h 22m");
});

it("fits six-character model names, their versions and every effort label", () => {
  fits(["Opus", "Sonnet", "Haiku", "Sol", "Luna", "Astra", "GPT"], 11, tracks.model.ch * ch);
  fits(["5.5", "6.1", "8.8"], 11, tracks.version.ch * ch);
  fits(["Low", "Med", "High", "XHigh", "Max"], 11, tracks.effort * 16);
});

it("reserves the role track and its gap only for icons", () => {
  const hidden = new Set<string>();
  const names = sidebarColumnBudget(hidden, "name");
  const icons = sidebarColumnBudget(hidden, "icon");
  expect(icons.rem - names.rem).toBe(sidebarColumnLayout.tracks.role);
  expect(icons.px - names.px).toBe(sidebarColumnLayout.gapPx);
});

it("fits the longest role labels with a narrow space at the 12px row font", () => {
  const track = tracks.name.ch * ch;
  expect(track - 85, "Orchestrator").toBeGreaterThanOrEqual(3);
  expect(track - 79, "Investigator").toBeGreaterThanOrEqual(3);
});
