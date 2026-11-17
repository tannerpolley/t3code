import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { resolveProjectExpanded, useUiStateStore } from "../../uiStateStore";
import { sidebarFolderExpansionKeys } from "../Sidebar.logic";
import type { ProjectSectionDialogTarget } from "./SidebarProjectSections";

/** The Projects sidebar view's mode, sections, project expansion, and section dialog state. */
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
  // `id` remounts the dialog per opening so its name field starts fresh; `open` stays separate so
  // the dialog keeps its content while it animates closed.
  const [sectionDialog, setSectionDialog] = useState<{
    readonly target: ProjectSectionDialogTarget;
    readonly open: boolean;
    readonly id: number;
  } | null>(null);
  const openSectionDialog = (target: ProjectSectionDialogTarget) => {
    if (useUiStateStore.getState().sidebarDisplaySnapshot !== null) return;
    setSectionDialog((current) => ({ target, open: true, id: (current?.id ?? 0) + 1 }));
  };
  const setSectionDialogOpen = (open: boolean) => {
    setSectionDialog((current) => (current ? { ...current, open } : current));
  };
  const openCreateSectionDialog = () => openSectionDialog({ kind: "create" });
  const openCreateSubsectionDialog = (parent: { readonly id: string; readonly name: string }) =>
    openSectionDialog({ kind: "create", parent: { id: parent.id, name: parent.name } });
  const openRenameSectionDialog = (section: { readonly id: string; readonly name: string }) =>
    openSectionDialog({ kind: "rename", id: section.id, name: section.name });
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
    sectionDialog,
    setSectionDialogOpen,
    openCreateSectionDialog,
    openCreateSubsectionDialog,
    openRenameSectionDialog,
    projectExpansionKeys,
    isProjectExpanded,
    toggleProjectExpanded,
  };
}
