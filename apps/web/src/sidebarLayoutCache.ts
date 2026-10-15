import { SidebarLayout } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { UiProjectState } from "./uiStateStore";

export const SIDEBAR_LAYOUT_CACHE_KEY = "t3code:sidebar-projection-cache:v1";
export const SECTION_FOLDER_COLORS_CACHE_KEY = "t3code:section-folder-colors-cache:v1";
const decodeLayout = Schema.decodeUnknownOption(Schema.fromJsonString(SidebarLayout));

/** Display-only projection; never a source for layout mutations or legacy import. */
export function readCachedSidebarLayout() {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_LAYOUT_CACHE_KEY);
    const layout = raw ? Option.getOrNull(decodeLayout(raw)) : null;
    return layout === null
      ? null
      : {
          ...layout,
          sidebarProjectSections: layout.sidebarProjectSections.map((section) => ({
            ...section,
            projectKeys: [...section.projectKeys],
          })),
          projectOrder: [...layout.projectOrder],
        };
  } catch {
    return null;
  }
}

export function cacheSidebarLayout(state: UiProjectState): void {
  try {
    const serialized = JSON.stringify({
      sidebarProjectSections: state.sidebarProjectSections,
      projectExpandedById: state.projectExpandedById,
      projectOrder: state.projectOrder,
      sidebarOtherProjectsExpanded: state.sidebarOtherProjectsExpanded,
    });
    if (window.localStorage.getItem(SIDEBAR_LAYOUT_CACHE_KEY) !== serialized)
      window.localStorage.setItem(SIDEBAR_LAYOUT_CACHE_KEY, serialized);
  } catch {
    /* Startup caches are optional when storage is unavailable. */
  }
}

export function readCachedSectionFolderColors(): boolean | undefined {
  try {
    const raw = window.localStorage.getItem(SECTION_FOLDER_COLORS_CACHE_KEY);
    return raw === "true" ? true : raw === "false" ? false : undefined;
  } catch {
    return undefined;
  }
}

export function cacheSectionFolderColors(enabled: boolean): void {
  try {
    const serialized = String(enabled);
    if (window.localStorage.getItem(SECTION_FOLDER_COLORS_CACHE_KEY) !== serialized)
      window.localStorage.setItem(SECTION_FOLDER_COLORS_CACHE_KEY, serialized);
  } catch {
    /* Startup caches are optional when storage is unavailable. */
  }
}
