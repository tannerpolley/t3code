import {
  EMPTY_SIDEBAR_LAYOUT,
  type EnvironmentId,
  type SidebarLayout,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import type { SidebarProjectSnapshot } from "./sidebarProjectGrouping";
import type { UiProjectState } from "./uiStateStore";
import { derivePhysicalProjectKey, deriveLogicalProjectKeyFromSettings } from "./logicalProject";
import { legacyProjectCwdPreferenceKey } from "./uiStateStore";

export function sidebarSectionKey(environmentId: EnvironmentId, sectionId: string): string {
  return JSON.stringify([environmentId, sectionId]);
}

/** Present durable project IDs as rows using the current grouping preference. */
export function projectSidebarLayout(input: {
  layouts: ReadonlyMap<EnvironmentId, SidebarLayout | undefined>;
  groups: readonly SidebarProjectSnapshot[];
  primaryEnvironmentId: EnvironmentId | null;
}): Pick<
  UiProjectState,
  "sidebarProjectSections" | "projectExpandedById" | "projectOrder" | "sidebarOtherProjectsExpanded"
> {
  const rowsById = new Map<string, string>();
  const orderKeysById = new Map<string, string>();
  for (const group of input.groups)
    for (const member of group.memberProjects) {
      rowsById.set(JSON.stringify([member.environmentId, member.id]), group.projectKey);
      orderKeysById.set(
        JSON.stringify([member.environmentId, member.id]),
        derivePhysicalProjectKey(member),
      );
    }
  const environments = [...input.layouts.keys()].sort((a, b) =>
    a === input.primaryEnvironmentId
      ? -1
      : b === input.primaryEnvironmentId
        ? 1
        : a.localeCompare(b),
  );
  const sections: UiProjectState["sidebarProjectSections"] = [];
  const expanded: Record<string, boolean> = {};
  const order: string[] = [];
  const claimed = new Set<string>();
  for (const environmentId of environments) {
    const layout = input.layouts.get(environmentId) ?? EMPTY_SIDEBAR_LAYOUT;
    const rowKey = (id: string) => rowsById.get(JSON.stringify([environmentId, id]));
    for (const section of layout.sidebarProjectSections) {
      const keys = section.projectKeys.flatMap((id) => {
        const key = rowKey(id);
        if (!key || claimed.has(key)) return [];
        claimed.add(key);
        return [key];
      });
      sections.push({
        ...section,
        id: sidebarSectionKey(environmentId, section.id),
        projectKeys: keys,
        ...(section.parentId === undefined
          ? {}
          : { parentId: sidebarSectionKey(environmentId, section.parentId) }),
      });
    }
    for (const [id, value] of Object.entries(layout.projectExpandedById)) {
      const key = rowKey(id);
      if (key && expanded[key] === undefined) expanded[key] = value;
      const orderKey = orderKeysById.get(JSON.stringify([environmentId, id]));
      if (orderKey) expanded[orderKey] = value;
    }
    for (const id of layout.projectOrder) {
      const key = orderKeysById.get(JSON.stringify([environmentId, id]));
      if (key) order.push(key);
    }
  }
  return {
    sidebarProjectSections: sections,
    projectExpandedById: expanded,
    projectOrder: order,
    sidebarOtherProjectsExpanded:
      (input.primaryEnvironmentId === null
        ? undefined
        : input.layouts.get(input.primaryEnvironmentId)
      )?.sidebarOtherProjectsExpanded ?? true,
  };
}

/** Resolve the old logical/path keys once; new storage never needs repository re-keying. */
export function migrateSidebarLayout(
  legacy: SidebarLayout,
  groups: readonly SidebarProjectSnapshot[],
  environmentId: EnvironmentId,
): SidebarLayout {
  const aliases = new Map<string, string[]>();
  for (const group of groups)
    for (const member of group.memberProjects) {
      if (member.environmentId !== environmentId) continue;
      for (const key of [
        group.projectKey,
        ...(["repository", "repository_path", "separate"] as const).map(
          (sidebarProjectGroupingMode) =>
            deriveLogicalProjectKeyFromSettings(member, {
              sidebarProjectGroupingMode,
              sidebarProjectGroupingOverrides: {},
            }),
        ),
        derivePhysicalProjectKey(member),
        member.id,
        member.environmentId + ":" + member.id,
        legacyProjectCwdPreferenceKey(member.workspaceRoot),
      ]) {
        aliases.set(key, [...new Set([...(aliases.get(key) ?? []), member.id])]);
      }
    }
  const resolve = (keys: readonly string[]) => [
    ...new Set(keys.flatMap((key) => aliases.get(key) ?? [])),
  ];
  const claimed = new Set<string>();
  return {
    sidebarProjectSections: legacy.sidebarProjectSections.map((section) => ({
      ...section,
      projectKeys: resolve(section.projectKeys).filter((id) => {
        if (claimed.has(id)) return false;
        claimed.add(id);
        return true;
      }),
    })),
    projectExpandedById: Object.fromEntries([
      ...groups.flatMap((group) =>
        group.memberProjects
          .filter(
            (member) =>
              member.environmentId === environmentId &&
              legacy.projectExpandedById["legacy-project-expansion-default"] !== undefined,
          )
          .map(
            (member) =>
              [member.id, legacy.projectExpandedById["legacy-project-expansion-default"]!] as const,
          ),
      ),
      ...Object.entries(legacy.projectExpandedById).flatMap(([key, value]) =>
        resolve([key]).map((id) => [id, value]),
      ),
    ]),
    projectOrder: resolve(legacy.projectOrder),
    sidebarOtherProjectsExpanded: legacy.sidebarOtherProjectsExpanded,
  };
}

export function sidebarProjectRefsForKeys(
  groups: readonly SidebarProjectSnapshot[],
  keys: readonly string[],
): ScopedProjectRef[] {
  const requested = new Set(keys);
  return groups.flatMap((group) =>
    requested.has(group.projectKey)
      ? [...group.memberProjectRefs]
      : group.memberProjects
          .filter(
            (member) =>
              requested.has(derivePhysicalProjectKey(member)) ||
              requested.has(member.environmentId + ":" + member.id),
          )
          .map((member) => ({ environmentId: member.environmentId, projectId: member.id })),
  );
}
