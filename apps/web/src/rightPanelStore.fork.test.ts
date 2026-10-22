import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { RunId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useClosedViewStore } from "./closedViewStore";

import {
  ISSUES_PANEL_REF,
  issueSurface,
  issueSurfaceId,
  migratePersistedRightPanelState,
  pullRequestSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));

beforeEach(() => {
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

describe("rightPanelStore", () => {
  const completedDiff = { kind: "diff", turnId: RunId.make("turn-1") } as const;
  const linkedPullRequest = pullRequestSurface({
    projectId: "project-a",
    repository: "pingdotgg/t3code",
    number: 42,
  });

  it("deduplicates canonical issues while keeping hosts and environments separate", () => {
    const first = {
      environmentId: "local",
      projectId: "project-a",
      host: " github.com ",
      repository: "PingDotGG/T3Code",
      number: 4909,
    };
    const otherHost = { ...first, host: "github.example.com" };
    const otherEnvironment = { ...first, environmentId: "remote" };

    useRightPanelStore.getState().openIssue(refA, first);
    useRightPanelStore
      .getState()
      .openIssue(refA, { ...first, host: "GITHUB.COM", repository: "pingdotgg/t3code" });
    useRightPanelStore.getState().openIssue(refA, otherHost);
    useRightPanelStore.getState().openIssue(refA, otherEnvironment);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces).toEqual([
      issueSurface(first),
      issueSurface(otherHost),
      issueSurface(otherEnvironment),
    ]);
    expect(issueSurfaceId({ ...first, host: "GITHUB.COM", repository: "pingdotgg/t3code" })).toBe(
      issueSurfaceId(first),
    );
  });

  it("scopes an omitted issue environment to the thread ref", () => {
    const target = {
      projectId: "project-a",
      host: "github.com",
      repository: "pingdotgg/t3code",
      number: 4909,
    };
    useRightPanelStore.getState().openIssue(refA, target);
    useRightPanelStore.getState().openIssue(refA, { ...target, environmentId: "env-2" });

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toEqual([
      issueSurface({ ...target, environmentId: "env-1" }),
      issueSurface({ ...target, environmentId: "env-2" }),
    ]);
  });

  it("keeps issue identity but drops detail payloads and the page sentinel on migration", () => {
    const target = {
      environmentId: "env-1",
      projectId: "project-a",
      host: "GITHUB.COM",
      repository: "pingdotgg/t3code",
      number: 4909,
    };
    const id = issueSurfaceId(target);
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          [scopedThreadKey(ISSUES_PANEL_REF)]: {
            isOpen: true,
            activeSurfaceId: id,
            surfaces: [issueSurface(target)],
          },
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: id,
            surfaces: [{ ...issueSurface(target), body: "must not persist" }],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: id,
          surfaces: [issueSurface(target)],
        },
      },
      threadPanelVisibilityByThreadKey: {},
    });
  });

  it("keeps one issue-list tab, scoped to its repository, beside the issues it opens across a reload", () => {
    const target = { host: "github.com", repository: "pingdotgg/t3code", number: 4909 };
    const scope = { host: "github.com", repository: "pingdotgg/t3code" };
    const store = useRightPanelStore.getState();
    store.openIssueList(refA, null);
    store.openIssue(refA, target);
    store.openIssueList(refA, scope);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    const surfaces = [
      { id: "issues", kind: "issues", scope },
      issueSurface({ ...target, environmentId: "env-1" }),
    ];
    expect(state).toMatchObject({ isOpen: true, activeSurfaceId: "issues", surfaces });
    expect(
      migratePersistedRightPanelState(JSON.parse(JSON.stringify({ byThreadKey: { a: state } })))
        .byThreadKey.a,
    ).toEqual({ isOpen: true, activeSurfaceId: "issues", surfaces });

    store.openIssueList(refA, null);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces[0],
    ).toEqual({ id: "issues", kind: "issues" });
  });

  it("closes the final issue surface and hides the panel", () => {
    const target = {
      environmentId: "env-1",
      projectId: "project-a",
      host: "github.com",
      repository: "pingdotgg/t3code",
      number: 4909,
    };
    useRightPanelStore.getState().openIssue(refA, target);
    useRightPanelStore.getState().closeSurface(refA, issueSurfaceId(target));

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });
});
