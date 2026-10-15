import { useCallback, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { resolveProjectExpanded, useUiStateStore } from "../../uiStateStore";
import type { ProjectSectionDialogTarget } from "./SidebarProjectSections";

/** The Projects sidebar view's mode, sections, project expansion, and section dialog state. */
export function useSidebarProjectsView() {
  // Without the Projects view switched on, the sidebar is the vanilla Activity list.
  const storedSidebarMode = useUiStateStore((store) => store.sidebarMode);
  const projectsViewEnabled = useClientSettings((settings) => settings.projectsView);
  const sidebarMode = projectsViewEnabled ? storedSidebarMode : "activity";
  const setSidebarMode = useUiStateStore((store) => store.setSidebarMode);
  const sidebarProjectSections = useUiStateStore((store) => store.sidebarProjectSections);
  const sectionFolderColors = useClientSettings((settings) => settings.sectionFolderColors);
  const sidebarOtherProjectsExpanded = useUiStateStore(
    (store) => store.sidebarOtherProjectsExpanded,
  );
  // `id` remounts the dialog per opening so its name field starts fresh; `open` stays separate so
  // the dialog keeps its content while it animates closed.
  const [sectionDialog, setSectionDialog] = useState<{
    readonly target: ProjectSectionDialogTarget;
    readonly open: boolean;
    readonly id: number;
  } | null>(null);
  const openSectionDialog = useCallback((target: ProjectSectionDialogTarget) => {
    if (useUiStateStore.getState().sidebarDisplaySnapshot !== null) return;
    setSectionDialog((current) => ({ target, open: true, id: (current?.id ?? 0) + 1 }));
  }, []);
  const setSectionDialogOpen = useCallback((open: boolean) => {
    setSectionDialog((current) => (current ? { ...current, open } : current));
  }, []);
  const openCreateSectionDialog = useCallback(
    () => openSectionDialog({ kind: "create" }),
    [openSectionDialog],
  );
  const openCreateSubsectionDialog = useCallback(
    (parent: { readonly id: string; readonly name: string }) =>
      openSectionDialog({ kind: "create", parent: { id: parent.id, name: parent.name } }),
    [openSectionDialog],
  );
  const openRenameSectionDialog = useCallback(
    (section: { readonly id: string; readonly name: string }) =>
      openSectionDialog({ kind: "rename", id: section.id, name: section.name }),
    [openSectionDialog],
  );
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const isProjectExpanded = useCallback(
    (projectKey: string) => resolveProjectExpanded(projectExpandedById, [projectKey]),
    [projectExpandedById],
  );
  const toggleProjectExpanded = useCallback(
    (projectKey: string, expanded: boolean) => setProjectExpanded(projectKey, expanded),
    [setProjectExpanded],
  );
  return {
    projectsViewEnabled,
    sidebarMode,
    setSidebarMode,
    sidebarProjectSections,
    sectionFolderColors,
    sidebarOtherProjectsExpanded,
    sectionDialog,
    setSectionDialogOpen,
    openCreateSectionDialog,
    openCreateSubsectionDialog,
    openRenameSectionDialog,
    isProjectExpanded,
    toggleProjectExpanded,
  };
}
