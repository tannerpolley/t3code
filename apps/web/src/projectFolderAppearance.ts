import type { ProjectIconColor } from "@t3tools/contracts";
import { useClientSettings } from "./hooks/useSettings";
import { useUiStateStore, type SidebarProjectSection } from "./uiStateStore";

/** A section's folder tint and forced-folder flag, inherited from its parent when unset. */
export function inheritedSectionFolderAppearance(
  section: Pick<SidebarProjectSection, "color" | "folderIcons">,
  parent: Pick<SidebarProjectSection, "color" | "folderIcons"> | undefined,
): { readonly color: ProjectIconColor | undefined; readonly folderIcons: boolean } {
  return {
    color: section.color ?? parent?.color,
    folderIcons: section.folderIcons === true || parent?.folderIcons === true,
  };
}

export interface ProjectFolderAppearance {
  readonly folderColor: ProjectIconColor | undefined;
  readonly forceFolder: boolean;
}

/**
 * The folder look a project's sidebar section gives it: the section's (or its parent's) color,
 * gated by the "Folder colors" setting, and whether the section forces the folder icon over a
 * custom one. Every place a project's icon stands for its identity resolves through this, so a
 * section's folder settings never drift between the sidebar and the rest of the app.
 */
export function resolveProjectFolderAppearance(
  projectKey: string | null,
  sections: readonly SidebarProjectSection[],
  folderColorsEnabled: boolean,
): ProjectFolderAppearance {
  const section =
    projectKey === null
      ? undefined
      : sections.find((candidate) => candidate.projectKeys.includes(projectKey));
  const parent =
    section?.parentId === undefined
      ? undefined
      : sections.find((candidate) => candidate.id === section.parentId);
  const { color, folderIcons } = inheritedSectionFolderAppearance(section ?? {}, parent);
  return {
    folderColor: folderColorsEnabled ? color : undefined,
    forceFolder: folderIcons,
  };
}

/** {@link resolveProjectFolderAppearance}, read live off the sidebar's own section state. */
export function useProjectFolderAppearance(projectKey: string | null): ProjectFolderAppearance {
  const sections = useUiStateStore((store) => store.sidebarProjectSections);
  const folderColorsEnabled = useClientSettings((settings) => settings.sectionFolderColors);
  return resolveProjectFolderAppearance(projectKey, sections, folderColorsEnabled);
}
