import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  issueFilterProjects,
  issueListTargets,
  issuesPageSearchFromUrl,
  issuesSearchFromUrl,
  roadmapSearchFromUrl,
} from "./issuesSearch.logic";

describe("issuesSearchFromUrl", () => {
  it("replaces a malformed filter instead of letting the raw value through", () => {
    // The router lays the validated keys over the raw search, so a key left out keeps its raw value.
    const raw = { label: true, order: "oldest", assignee: "   ", host: true };
    const search = { ...raw, ...issuesSearchFromUrl(raw) };
    expect(search.host).toBeUndefined();
    expect(search.label).toBeUndefined();
    expect(search.assignee).toBeUndefined();
    expect(search.order).toBeUndefined();
    expect(issuesSearchFromUrl({ label: "bug" }).label).toEqual(["bug"]);
    expect(issuesSearchFromUrl({ label: ["bug", " ui "], order: "created" })).toMatchObject({
      label: ["bug", "ui"],
      order: "created",
    });
    expect(
      issuesSearchFromUrl({ hideProjects: [["env", "web"], ["env"], "api", ["env", 3]] })
        .hideProjects,
    ).toEqual([
      ["env", "web"],
      ["env", "3"],
    ]);
  });
});

function canonicalIssuesSearch(
  initialUrl: string,
  preferred?: Parameters<typeof issuesPageSearchFromUrl>[1],
) {
  const rootRoute = createRootRoute();
  const issuesRoute = createRoute({
    path: "/issues",
    getParentRoute: () => rootRoute,
    validateSearch: (raw: Record<string, unknown>) => issuesPageSearchFromUrl(raw, preferred),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([issuesRoute]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  const canonicalLocation = router.buildLocation({
    to: "/issues",
    search: true,
    _includeValidateSearch: true,
  });
  return router.matchRoutes(canonicalLocation).at(-1)?.search;
}

describe("issuesPageSearchFromUrl", () => {
  it("keeps the default and saved view through the router's initial URL normalization", () => {
    expect(canonicalIssuesSearch("/issues")).toMatchObject({ view: "board" });
    expect(canonicalIssuesSearch("/issues", () => ({ view: "board" }))).toMatchObject({
      view: "board",
    });
    expect(
      canonicalIssuesSearch("/issues", () => ({
        view: "list",
        who: "assigned",
        status: "open",
        q: "regression",
      })),
    ).toMatchObject({ view: "list", who: "assigned", q: "regression" });
  });

  it.each(["true", "123"])(
    "clears malformed board text fields with value %s from the matched search",
    (invalid) => {
      const search = canonicalIssuesSearch(
        `/issues?view=board&repository=${invalid}&environmentId=${invalid}&selectedRepository=${invalid}&number=-1`,
      );
      expect(search).toMatchObject({
        view: "board",
        repository: undefined,
        environmentId: undefined,
        selectedRepository: undefined,
        number: undefined,
      });
    },
  );

  it("preserves links to the original list, including tracker issue keys parsed as numbers", () => {
    expect(
      canonicalIssuesSearch("/issues?selectedProjectId=app&tracker=github&scope=acme%2Fapp&key=42"),
    ).toMatchObject({ view: "list", selectedProjectId: "app", scope: "acme/app", key: "42" });
    expect(issuesPageSearchFromUrl({ host: "gitlab.com" }).view).toBe("list");
    expect(issuesPageSearchFromUrl({ view: "other" }).view).toBe("board");
  });

  it("retains the scope and selection when a legacy roadmap link forces the board", () => {
    const legacy = roadmapSearchFromUrl({
      environmentId: "remote",
      host: "github.com",
      repository: "acme/app",
      number: "42",
      selectedRepository: "acme/other",
      selectedNumber: 7,
      issueQuery: "build",
      originThreadId: "thread",
    });
    expect(issuesPageSearchFromUrl({ ...legacy, view: "board" })).toMatchObject({
      view: "board",
      environmentId: "remote",
      host: "github.com",
      repository: "acme/app",
      number: 42,
      selectedRepository: "acme/other",
      selectedNumber: 7,
      issueQuery: "build",
      originThreadId: "thread",
    });
  });
});

describe("issueListTargets", () => {
  it("leaves hidden projects out and skips an environment with every project hidden", () => {
    const laptop = EnvironmentId.make("laptop");
    const vps = EnvironmentId.make("vps");
    const projects = [
      { environmentId: laptop, id: ProjectId.make("web") },
      { environmentId: laptop, id: ProjectId.make("api") },
      { environmentId: vps, id: ProjectId.make("docs") },
    ];
    const input = { state: "open" } as const;
    const hidden = [
      [laptop, ProjectId.make("api")],
      [laptop, ProjectId.make("removed")],
      [vps, ProjectId.make("docs")],
    ] as const;
    expect(issueListTargets([laptop, vps], projects, hidden, input)).toEqual([
      { environmentId: laptop, input: { state: "open", excludeProjectIds: ["api"] } },
    ]);
    // Before the project list loads, the saved choice still leaves its projects out.
    expect(issueListTargets([laptop, vps], [], hidden, input)).toEqual([
      { environmentId: laptop, input: { state: "open", excludeProjectIds: ["api", "removed"] } },
      { environmentId: vps, input: { state: "open", excludeProjectIds: ["docs"] } },
    ]);
    expect(issueListTargets([laptop, vps], projects, undefined, input)).toEqual([
      { environmentId: laptop, input },
      { environmentId: vps, input },
    ]);
  });
});

describe("issueFilterProjects", () => {
  it("keeps every project, scratch ones too, as its own choice", () => {
    const environmentId = EnvironmentId.make("env");
    const project = (id: string, isScratch = false) =>
      ({
        id: ProjectId.make(id),
        environmentId,
        title: "t3code",
        workspaceRoot: `/work/${id}`,
        repositoryIdentity: { canonicalKey: "github.com/pingdotgg/t3code" },
        isScratch,
      }) as unknown as EnvironmentProject;
    const choices = issueFilterProjects(
      [project("main"), project("worktree"), project("scratch", true)],
      new Map([[environmentId, "laptop"]]),
    );
    expect(choices.map((choice) => [choice.id, choice.title])).toEqual([
      ["main", "t3code · laptop · /work/main"],
      ["scratch", "t3code · laptop · /work/scratch"],
      ["worktree", "t3code · laptop · /work/worktree"],
    ]);
  });
});
