import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useRef } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { resolveProjectExpanded, type SidebarMode, useUiStateStore } from "../../uiStateStore";
import { sidebarFolderExpansionKeys } from "../Sidebar.logic";
import { resolveSidebarReveal } from "./SidebarReveal.logic";

/** The Projects sidebar view's mode, sections, and project expansion. */
export function useSidebarProjectsView(
  projectGroupByKey: ReadonlyMap<string, SidebarProjectSnapshot>,
) {
  // Without the Projects view switched on, the sidebar is the vanilla Activity list.
  const storedSidebarMode = useUiStateStore((store) => store.sidebarMode);
  const projectsViewEnabled = useClientSettings((settings) => settings.projectsView);
  const sidebarMode = projectsViewEnabled ? storedSidebarMode : "activity";
  const setSidebarMode = useUiStateStore((store) => store.setSidebarMode);
  const sidebarProjectSections = useUiStateStore((store) => store.sidebarProjectSections);
  const sidebarOtherProjectsExpanded = useUiStateStore(
    (store) => store.sidebarOtherProjectsExpanded,
  );
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  // Same keys as Activity's folders, so both views open and close one project together.
  const projectExpansionKeys = (projectKey: string) => {
    const group = projectGroupByKey.get(projectKey);
    return group ? sidebarFolderExpansionKeys(group) : [projectKey];
  };
  const isProjectExpanded = (projectKey: string) =>
    resolveProjectExpanded(projectExpandedById, projectExpansionKeys(projectKey));
  const toggleProjectExpanded = (projectKey: string, expanded: boolean) =>
    setProjectExpanded(projectExpansionKeys(projectKey), expanded);
  return {
    projectsViewEnabled,
    sidebarMode,
    setSidebarMode,
    sidebarProjectSections,
    sidebarOtherProjectsExpanded,
    projectExpansionKeys,
    isProjectExpanded,
    toggleProjectExpanded,
  };
}

/**
 * Opens the sections and project that hold the thread the route moved to, however it got there
 * (link, search, palette, notification, shortcut, Back). Runs once per change of the open thread,
 * so a project collapsed afterwards stays collapsed. The active row's reveal ref scrolls to it and
 * route reveal widens the Activity scope; this only opens what hides the row in Projects.
 */
export function useProjectsRouteReveal(input: {
  readonly routeThreadKey: string | null;
  readonly threads: readonly SidebarThreadSummary[];
  readonly logicalProjectKeyByScopedProjectRef: ReadonlyMap<string, string>;
  readonly sidebarMode: SidebarMode;
  readonly projectExpansionKeys: (projectKey: string) => readonly string[];
  readonly toggleProjectExpanded: (projectKey: string, expanded: boolean) => void;
  /** Search results replace the list, so a reveal clears the search. */
  readonly onReveal: () => void;
}) {
  const {
    routeThreadKey,
    threads,
    logicalProjectKeyByScopedProjectRef,
    sidebarMode,
    projectExpansionKeys,
    toggleProjectExpanded,
    onReveal,
  } = input;
  const revealOpenThread = useClientSettings((s) => s.revealOpenThreadInSidebar);
  const revealedThreadKeyRef = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Opens the layout around the thread a navigation made active; the thread may load after the route, so it retries as threads arrive.
  useEffect(() => {
    if (routeThreadKey === null || !revealOpenThread) {
      // Turning the switch on later must not reveal a thread that was opened while it was off.
      revealedThreadKeyRef.current = routeThreadKey;
      return;
    }
    if (revealedThreadKeyRef.current === routeThreadKey) return;
    const threadByKey = new Map(
      threads.map((thread) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        thread,
      ]),
    );
    const uiState = useUiStateStore.getState();
    const reveal = resolveSidebarReveal({
      threadKey: routeThreadKey,
      getThread: (key) => {
        const thread = threadByKey.get(key);
        if (thread === undefined) return undefined;
        const { parentThreadId, relationshipToParent } = thread.lineage;
        return {
          parentKey:
            relationshipToParent === "subagent" && parentThreadId !== null
              ? scopedThreadKey(scopeThreadRef(thread.environmentId, parentThreadId))
              : null,
          projectKey:
            logicalProjectKeyByScopedProjectRef.get(
              `${thread.environmentId}:${thread.projectId}`,
            ) ?? null,
          archived: thread.archivedAt !== null,
        };
      },
      sections: uiState.sidebarProjectSections,
      otherProjectsExpanded: uiState.sidebarOtherProjectsExpanded,
      isProjectExpanded: (projectKey) =>
        resolveProjectExpanded(uiState.projectExpandedById, projectExpansionKeys(projectKey)),
    });
    if (reveal === null) return;
    revealedThreadKeyRef.current = routeThreadKey;
    onReveal();
    if (sidebarMode !== "projects") return;
    for (const sectionId of reveal.expandSectionIds) {
      uiState.setSidebarProjectSectionExpanded(sectionId, true);
    }
    if (reveal.expandOtherProjects) uiState.setSidebarOtherProjectsExpanded(true);
    if (reveal.expandProject) toggleProjectExpanded(reveal.projectKey, true);
  }, [
    logicalProjectKeyByScopedProjectRef,
    onReveal,
    projectExpansionKeys,
    revealOpenThread,
    routeThreadKey,
    sidebarMode,
    threads,
    toggleProjectExpanded,
  ]);
}
