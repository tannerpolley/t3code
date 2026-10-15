import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  formatSidebarUsage,
  remainingToUsedPercent,
  selectSidebarUsage,
  sidebarUsedClass,
  sumSidebarProjectUsage,
} from "./SidebarProjectUsage.logic";

const drivers = new Map([
  ["local:codex", "codex"],
  ["local:claude", "claudeAgent"],
  // Instance ids only have meaning in their own environment.
  ["remote:codex", "claudeAgent"],
  ["local:other", "cursor"],
]);
const thread = (project: string, provider: string, percent?: number, environment = "local") => ({
  environmentId: EnvironmentId.make(environment),
  projectId: ProjectId.make(project),
  providerInstanceId: ProviderInstanceId.make(provider),
  source: {
    usageSummary:
      percent === undefined ? undefined : { weeklyLimitPercent: percent, partial: false },
  },
});

describe("Projects usage breakdown", () => {
  it("sums each project's providers before rounding, including all members of a merged project", () => {
    const sums = sumSidebarProjectUsage(
      [
        thread("a", "codex", 0.8),
        thread("a", "codex", 1.8),
        thread("a", "claude", 12),
        thread("a", "codex", 7, "remote"),
        thread("b", "claude", 3),
      ],
      drivers,
    );
    expect(sums.get("local:a")).toEqual({ codex: 2.6, claudeAgent: 12 });
    expect(sums.get("remote:a")).toEqual({ claudeAgent: 7 });
    const merged = selectSidebarUsage(sums, new Set(["local:a", "remote:a"]));
    expect(merged).toEqual({ codex: 2.6, claudeAgent: 19 });
    expect(formatSidebarUsage(merged.codex)).toBe("2%");
  });

  it("puts only projects without listed rows into Remaining projects, including unknown projects", () => {
    const sums = sumSidebarProjectUsage(
      [
        thread("listed", "codex", 10),
        thread("collapsed", "codex", 20),
        thread("collapsed", "claude", 4),
        thread("unlisted", "claude", 7),
      ],
      drivers,
    );
    expect(selectSidebarUsage(sums, new Set(["local:listed"]), true)).toEqual({
      codex: 20,
      claudeAgent: 11,
    });
    // Expanding a section moves its sum into its project row, without double counting it.
    expect(selectSidebarUsage(sums, new Set(["local:listed", "local:collapsed"]), true)).toEqual({
      claudeAgent: 7,
    });
    expect(selectSidebarUsage(sums, new Set(), true)).toEqual({ codex: 30, claudeAgent: 11 });
    expect(selectSidebarUsage(sums, new Set(sums.keys()), true)).toEqual({});
  });

  it("keeps missing estimates unknown, a single provider independent, and measured zero visible", () => {
    expect(sumSidebarProjectUsage([], drivers).size).toBe(0);
    expect(selectSidebarUsage(new Map(), new Set(), true)).toEqual({});
    const sums = sumSidebarProjectUsage(
      [
        thread("a", "codex"),
        thread("a", "claude", 0),
        thread("a", "other", 42),
        thread("a", "missing", 42),
        thread("a", "codex", Number.NaN),
        thread("a", "codex", -2),
      ],
      drivers,
    );
    expect(sums.get("local:a")).toEqual({ claudeAgent: 0 });
    expect(formatSidebarUsage(sums.get("local:a")?.codex)).toBe("—");
    expect(formatSidebarUsage(sums.get("local:a")?.claudeAgent)).toBe("0%");
  });

  it("preserves estimates over 100% so the breakdown still adds up", () => {
    const sums = sumSidebarProjectUsage(
      [thread("a", "codex", 110), thread("a", "codex", 12.5)],
      drivers,
    );
    expect(selectSidebarUsage(sums, new Set(["local:a"]))).toEqual({ codex: 122.5 });
    expect(formatSidebarUsage(sums.get("local:a")?.codex)).toBe("122%");
    expect(sidebarUsedClass(122.5)).toBe("text-red-500");
  });
});

it("converts remaining quota to used, preserving unknown and over-budget readings", () => {
  expect([undefined, null, Number.NaN, 100, 90, 9, 0, -15].map(remainingToUsedPercent)).toEqual([
    null,
    null,
    null,
    0,
    10,
    91,
    100,
    115,
  ]);
  expect([10, 50, 91].map(sidebarUsedClass)).toEqual([
    "text-emerald-500",
    "text-amber-500",
    "text-red-500",
  ]);
});
