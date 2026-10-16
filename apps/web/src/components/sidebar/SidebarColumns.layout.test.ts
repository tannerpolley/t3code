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
  for (const column of sidebarColumnLayout.dropOrder) {
    const budget = sidebarColumnBudget(hidden);
    if (container < budget.rem * 16 + budget.px + budget.ch * ch) hidden.add(column);
  }
  return ["model", "effort", "usage"].filter((column) => !hidden.has(column));
};

describe("sidebar width budget", () => {
  it("protects ten title characters before admitting optional columns", () => {
    expect(optionalColumns(16)).toEqual([]);
    expect(optionalColumns(25)).toEqual(["model"]);
    expect(optionalColumns(27.5)).toEqual(["model", "effort"]);
    expect(optionalColumns(30)).toEqual(["model", "effort", "usage"]);
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
    "%": 2020,
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
const { tracks, modelPartsCh } = sidebarColumnLayout;

it("fits every elapsed label up to 99h 59m 59s inside the time track", () => {
  // Hours past 99 grow a digit and may spill; that is over four days on one turn.
  const samples = [0, 9, 59, 60, 309, 59 * 60 + 59, 3600, 3909, 10 * 3600, 99 * 3600 + 3599];
  fits(samples.map(formatElapsedSeconds), 10, tracks.time * 16);
});

it("fits six-character model names, their versions and every effort label", () => {
  expect(modelPartsCh.name + modelPartsCh.version).toBe(tracks.model.ch);
  fits(["Opus", "Sonnet", "Haiku", "Sol", "Luna", "Astra", "GPT"], 11, modelPartsCh.name * ch);
  fits(["5.5", "6.1", "8.8"], 11, modelPartsCh.version * ch);
  fits(["Low", "Med", "High", "XHigh", "Max"], 11, tracks.effort * 16);
});

it("fits a whole weekly-limit percent inside the usage track", () => {
  fits(["1%", "99%", "100%"], 11, tracks.usage * 16);
});
