import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveProjectPlacements } from "./projectSectionPlacement";

const ref = { environmentId: EnvironmentId.make("local"), projectId: ProjectId.make("p1") };
const refKey = "local:p1";
const placement = { sectionId: "apps", expiresAt: 1_000 };
const sections = [
  { id: "apps", projectKeys: ["other"] },
  { id: "work", projectKeys: [] },
];

describe("resolveProjectPlacements", () => {
  it("waits for the project, moves it, and keeps the placement until its identity settles", () => {
    expect(
      resolveProjectPlacements({
        placements: { [refKey]: placement },
        projects: [],
        sections,
        now: 0,
      }),
    ).toEqual({ moves: [], resolved: [] });
    const pending = { projectKey: "/tmp/p1", memberProjectRefs: [ref] };
    expect(
      resolveProjectPlacements({
        placements: { [refKey]: placement },
        projects: [pending],
        sections,
        now: 0,
      }),
    ).toEqual({ moves: [{ projectKey: "/tmp/p1", sectionId: "apps" }], resolved: [] });
    expect(
      resolveProjectPlacements({
        placements: { [refKey]: placement },
        projects: [{ ...pending, projectKey: "github.com/me/p1", repositoryIdentity: {} }],
        sections,
        now: 0,
      }),
    ).toEqual({
      moves: [{ projectKey: "github.com/me/p1", sectionId: "apps" }],
      resolved: [refKey],
    });
  });

  it("never undoes a manual move and drops expired or orphaned placements", () => {
    const grouped = { projectKey: "/tmp/p1", memberProjectRefs: [ref] };
    expect(
      resolveProjectPlacements({
        placements: { [refKey]: placement },
        projects: [grouped],
        sections: [
          { id: "apps", projectKeys: [] },
          { id: "work", projectKeys: ["/tmp/p1"] },
        ],
        now: 0,
      }).moves,
    ).toEqual([]);
    expect(
      resolveProjectPlacements({
        placements: { [refKey]: placement },
        projects: [],
        sections,
        now: 2_000,
      }).resolved,
    ).toEqual([refKey]);
    expect(
      resolveProjectPlacements({
        placements: { [refKey]: { sectionId: "deleted", expiresAt: 1_000 } },
        projects: [grouped],
        sections,
        now: 0,
      }),
    ).toEqual({ moves: [], resolved: [refKey] });
  });
});
