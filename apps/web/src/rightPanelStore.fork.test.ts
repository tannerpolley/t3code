import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useClosedViewStore } from "./closedViewStore";

import {
  issueSurface,
  migratePersistedRightPanelState,
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
  it("keeps one issue-list tab, scoped to its repository, beside the issues it opens across a reload", () => {
    const target = {
      environmentId: "env-1",
      projectId: "project-a",
      tracker: "github",
      host: "github.com",
      scope: "pingdotgg/t3code",
      key: "4909",
    };
    const scope = { host: "github.com", repository: "pingdotgg/t3code" };
    const store = useRightPanelStore.getState();
    store.openIssueList(refA, null);
    store.openIssue(refA, target);
    store.openIssueList(refA, scope);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    const surfaces = [{ id: "issues", kind: "issues", scope }, issueSurface(target)];
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

  it("closes issue tabs saved in the fork's repository-keyed shape", () => {
    const forkShaped = {
      id: "issue:env-1:github.com:pingdotgg%2Ft3code:4909",
      kind: "issue",
      environmentId: "env-1",
      host: "github.com",
      repository: "pingdotgg/t3code",
      number: 4909,
    };
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          a: { isOpen: true, activeSurfaceId: forkShaped.id, surfaces: [forkShaped] },
        },
      }).byThreadKey.a?.surfaces,
    ).toEqual([]);
  });
});
