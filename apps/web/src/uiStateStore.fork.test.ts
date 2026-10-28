import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  addSidebarProjectSection,
  deleteSidebarProjectSection,
  parsePersistedState,
  PERSISTED_STATE_KEY,
  type PersistedUiState,
  persistState,
  moveProjectToSidebarProjectSection,
  reorderSidebarProjectSectionProjects,
  reorderSidebarProjectSections,
  renameSidebarProjectSection,
  setBranchPickerGroupCollapsed,
  setLineageAgentsClearedAt,
  setIssueMilestoneCollapsed,
  setLineageDetailsExpanded,
  setSidebarMode,
  setSidebarOtherProjectsExpanded,
  setSidebarProjectSectionColor,
  setSidebarProjectSectionExpanded,
  setSidebarProjectSectionFolderIcons,
  type UiState,
} from "./uiStateStore";

import { issueSectionKey } from "./components/issues/useIssueSectionCollapsed";

function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    projectExpandedById: {},
    projectOrder: [],
    sidebarProjectSections: [],
    sidebarOtherProjectsExpanded: true,
    sidebarMode: "activity",
    sidebarProjectScopeKeys: [],
    threadLastVisitedAtById: {},
    threadChangedFilesExpandedById: {},
    defaultAdvertisedEndpointKey: null,
    pullRequestMergeMethod: "merge",
    lineageDetailsExpandedById: {},
    lineageAgentsClearedAtById: {},
    issueMilestoneCollapsedById: {},
    branchPickerCollapsedGroups: [],
    ...overrides,
  };
}

describe("uiStateStore pure functions", () => {
  it("collapses and expands branch picker groups independently", () => {
    const initial = makeUiState();
    const remoteCollapsed = setBranchPickerGroupCollapsed(initial, "remote", true);
    const bothCollapsed = setBranchPickerGroupCollapsed(remoteCollapsed, "current", true);

    expect(bothCollapsed.branchPickerCollapsedGroups).toEqual(["current", "remote"]);
    expect(setBranchPickerGroupCollapsed(bothCollapsed, "current", true)).toBe(bothCollapsed);
    expect(
      setBranchPickerGroupCollapsed(bothCollapsed, "remote", false).branchPickerCollapsedGroups,
    ).toEqual(["current"]);
  });

  it("keeps the Projects view and section organization independent of Activity filters", () => {
    const projects = setSidebarMode(makeUiState(), "projects");
    const work = addSidebarProjectSection(projects, { id: "work", name: " Work " });
    const personal = addSidebarProjectSection(work, { id: "personal", name: "Personal" });
    const placed = moveProjectToSidebarProjectSection(
      moveProjectToSidebarProjectSection(personal, "project-a", "work"),
      "project-b",
      "work",
    );
    const reordered = reorderSidebarProjectSectionProjects(placed, "work", [
      "project-b",
      "project-a",
    ]);
    const moved = moveProjectToSidebarProjectSection(reordered, "project-a", "personal");
    const collapsed = setSidebarProjectSectionExpanded(moved, "work", false);
    const renamed = renameSidebarProjectSection(collapsed, "work", "Now");
    const colored = setSidebarProjectSectionColor(renamed, "work", "blue");
    const folders = setSidebarProjectSectionFolderIcons(colored, "work", true);
    const ordered = reorderSidebarProjectSections(folders, ["personal", "work"]);

    expect(ordered.sidebarProjectSections).toEqual([
      { id: "personal", name: "Personal", projectKeys: ["project-a"], collapsed: false },
      {
        id: "work",
        name: "Now",
        projectKeys: ["project-b"],
        collapsed: true,
        color: "blue",
        folderIcons: true,
      },
    ]);
    expect(setSidebarOtherProjectsExpanded(ordered, false).sidebarOtherProjectsExpanded).toBe(
      false,
    );
    expect(deleteSidebarProjectSection(ordered, "work").sidebarProjectSections).toEqual([
      ordered.sidebarProjectSections[0],
    ]);
    expect(
      parsePersistedState({ sidebarProjectSections: ordered.sidebarProjectSections }),
    ).toMatchObject({
      sidebarMode: "projects",
      sidebarProjectSections: ordered.sidebarProjectSections,
    });
  });

  it("limits subsections to one level and returns their projects to the parent on delete", () => {
    const work = addSidebarProjectSection(makeUiState(), { id: "work", name: "Work" });
    const nested = addSidebarProjectSection(work, {
      id: "nested",
      name: "Nested",
      parentId: "work",
    });
    expect(addSidebarProjectSection(nested, { id: "deep", name: "Deep", parentId: "nested" })).toBe(
      nested,
    );
    const placed = moveProjectToSidebarProjectSection(nested, "project-a", "nested");
    expect(deleteSidebarProjectSection(placed, "nested").sidebarProjectSections).toEqual([
      { id: "work", name: "Work", projectKeys: ["project-a"], collapsed: false },
    ]);
  });

  it("remembers lineage expansion and clear timestamps", () => {
    const open = setLineageDetailsExpanded(makeUiState(), ["env:parent"], true);
    const cleared = setLineageAgentsClearedAt(open, "env:parent", "show-all");
    expect(cleared.lineageDetailsExpandedById).toEqual({ "env:parent": true });
    expect(cleared.lineageAgentsClearedAtById).toEqual({ "env:parent": "show-all" });
    expect(
      parsePersistedState({ lineageAgentsClearedAtById: { "env:parent": "show-all" } })
        .lineageAgentsClearedAtById,
    ).toEqual({ "env:parent": "show-all" });
    expect(
      setLineageAgentsClearedAt(cleared, "env:parent", null).lineageAgentsClearedAtById,
    ).toEqual({});
  });
});

describe("parsePersistedState", () => {
  it("keeps only known branch picker groups when hydrating collapsed groups", () => {
    expect(
      parsePersistedState({ branchPickerCollapsedGroups: ["remote", "stale", "current", "remote"] })
        .branchPickerCollapsedGroups,
    ).toEqual(["current", "remote"]);
    expect(
      parsePersistedState({ branchPickerCollapsedGroups: "remote" as unknown as string[] })
        .branchPickerCollapsedGroups,
    ).toEqual([]);
  });

  it("hydrates raw UI-owned state without server entities", () => {
    const parsed = parsePersistedState({
      projectExpandedById: {
        logical: false,
        invalid: "no" as unknown as boolean,
      },
      projectOrder: ["physical-b", "", "physical-a", "physical-b"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
        invalid: "not-a-date",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      threadChangedFilesExpansionVersion: 2,
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });

    expect(parsed).toEqual({
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      sidebarProjectSections: [],
      sidebarOtherProjectsExpanded: true,
      sidebarMode: "activity",
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      sidebarProjectScopeKeys: [],
      pullRequestMergeMethod: "merge",
      lineageDetailsExpandedById: {},
      lineageAgentsClearedAtById: {},
      issueMilestoneCollapsedById: {},
      branchPickerCollapsedGroups: [],
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });
  });
});

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => {
      store.clear();
    },
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

describe("uiStateStore persistence", () => {
  let localStorageStub: Storage;

  beforeEach(() => {
    localStorageStub = createLocalStorageStub();
    vi.stubGlobal("window", { localStorage: localStorageStub });
    vi.stubGlobal("localStorage", localStorageStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists window preferences without saving server layout projections", () => {
    const state = makeUiState({
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      sidebarProjectSections: [],
      sidebarOtherProjectsExpanded: true,
      sidebarMode: "activity",
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
    });

    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(persisted).toEqual({
      sidebarProjectScopeKey: null,
      projectExpandedById: {},
      projectOrder: [],
      sidebarProjectSections: [],
      sidebarOtherProjectsExpanded: true,
      sidebarMode: "activity",
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      sidebarProjectScopeKeys: [],
      threadChangedFilesExpansionVersion: 2,
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
      pullRequestMergeMethod: "merge",
      lineageDetailsExpandedById: {},
      lineageAgentsClearedAtById: {},
      issueMilestoneCollapsedById: {},
      branchPickerCollapsedGroups: [],
    });
    expect(parsePersistedState(persisted)).toEqual({
      ...state,
      projectExpandedById: {},
      projectOrder: [],
    });
  });

  it("persists issue sections independently by environment, host, repository and section", () => {
    const scope = {
      environmentId: EnvironmentId.make("local"),
      host: "github.com",
      repository: "owner/repo",
    };
    const ready = issueSectionKey(scope, "roadmap:ready");
    const review = issueSectionKey(scope, "roadmap:in-review");
    const milestone = issueSectionKey(scope, "milestone:1");
    const otherRepo = issueSectionKey({ ...scope, repository: "owner/other" }, "roadmap:ready");
    const otherHost = issueSectionKey({ ...scope, host: "github.example.com" }, "roadmap:ready");
    expect(
      issueSectionKey({ ...scope, host: "GitHub.COM", repository: "Owner/Repo" }, "roadmap:ready"),
    ).toBe(ready);
    let state = setIssueMilestoneCollapsed(makeUiState(), ready, true);
    state = setIssueMilestoneCollapsed(state, milestone, true);
    expect(setIssueMilestoneCollapsed(state, ready, true)).toBe(state);
    persistState(state);
    const restored = parsePersistedState(
      JSON.parse(localStorageStub.getItem(PERSISTED_STATE_KEY)!),
    );
    expect(restored.issueMilestoneCollapsedById[ready]).toBe(true);
    expect(restored.issueMilestoneCollapsedById[milestone]).toBe(true);
    for (const key of [review, otherRepo, otherHost]) {
      expect(restored.issueMilestoneCollapsedById[key] ?? false).toBe(false);
    }
    const reopened = setIssueMilestoneCollapsed(restored, ready, false);
    persistState(reopened);
    const reloaded = parsePersistedState(
      JSON.parse(localStorageStub.getItem(PERSISTED_STATE_KEY)!),
    );
    expect(reloaded.issueMilestoneCollapsedById[ready]).toBe(false);
    expect(reloaded.issueMilestoneCollapsedById[milestone]).toBe(true);
  });
});
