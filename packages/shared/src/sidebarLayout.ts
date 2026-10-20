import type {
  SidebarLayout,
  SidebarLayoutMutation,
  SidebarProjectSection,
  ProjectIconColor,
} from "@t3tools/contracts";
import { EMPTY_SIDEBAR_LAYOUT } from "@t3tools/contracts";
import { organizeSectionsByFolder } from "./sidebarSectionFolders.ts";
function normalizeSidebarProjectSectionName(name: string): string {
  return name.trim().slice(0, 80);
}
export function setSidebarOtherProjectsExpanded<T extends SidebarLayout>(
  state: T,
  expanded: boolean,
): T {
  return state.sidebarOtherProjectsExpanded === expanded
    ? state
    : { ...state, sidebarOtherProjectsExpanded: expanded };
}

export function addSidebarProjectSection<T extends SidebarLayout>(
  state: T,
  section: Pick<SidebarProjectSection, "id" | "name" | "parentId" | "folderPath">,
): T {
  const id = section.id.trim();
  const name = normalizeSidebarProjectSectionName(section.name);
  if (!id || !name || state.sidebarProjectSections.some((candidate) => candidate.id === id)) {
    return state;
  }
  const parent =
    section.parentId === undefined
      ? undefined
      : state.sidebarProjectSections.find((candidate) => candidate.id === section.parentId);
  if (section.parentId !== undefined && (!parent || parent.parentId !== undefined)) return state;
  return {
    ...state,
    sidebarProjectSections: [
      ...state.sidebarProjectSections,
      {
        id,
        name,
        projectKeys: [],
        collapsed: false,
        ...(parent ? { parentId: parent.id } : {}),
        ...(section.folderPath ? { folderPath: section.folderPath } : {}),
      },
    ],
  };
}

export function renameSidebarProjectSection<T extends SidebarLayout>(
  state: T,
  sectionId: string,
  name: string,
): T {
  const nextName = normalizeSidebarProjectSectionName(name);
  const section = state.sidebarProjectSections.find((candidate) => candidate.id === sectionId);
  if (!nextName || !section || section.name === nextName) return state;
  return {
    ...state,
    sidebarProjectSections: state.sidebarProjectSections.map((candidate) =>
      candidate.id === sectionId ? { ...candidate, name: nextName } : candidate,
    ),
  };
}

export function setSidebarProjectSectionColor<T extends SidebarLayout>(
  state: T,
  sectionId: string,
  color: ProjectIconColor | null,
): T {
  const section = state.sidebarProjectSections.find((candidate) => candidate.id === sectionId);
  if (!section || (section.color ?? null) === color) return state;
  return {
    ...state,
    sidebarProjectSections: state.sidebarProjectSections.map((candidate) => {
      if (candidate.id !== sectionId) return candidate;
      const { color: _color, ...rest } = candidate;
      return color === null ? rest : { ...rest, color };
    }),
  };
}

export function setSidebarProjectSectionFolderIcons<T extends SidebarLayout>(
  state: T,
  sectionId: string,
  folderIcons: boolean,
): T {
  const section = state.sidebarProjectSections.find((candidate) => candidate.id === sectionId);
  if (!section || (section.folderIcons === true) === folderIcons) return state;
  return {
    ...state,
    sidebarProjectSections: state.sidebarProjectSections.map((candidate) => {
      if (candidate.id !== sectionId) return candidate;
      const { folderIcons: _previous, ...rest } = candidate;
      return folderIcons ? { ...rest, folderIcons: true } : rest;
    }),
  };
}

export function deleteSidebarProjectSection<T extends SidebarLayout>(
  state: T,
  sectionId: string,
): T {
  const section = state.sidebarProjectSections.find((candidate) => candidate.id === sectionId);
  if (!section) return state;
  const sidebarProjectSections = state.sidebarProjectSections.flatMap((candidate) => {
    if (candidate.id === sectionId || candidate.parentId === sectionId) return [];
    if (candidate.id === section.parentId) {
      return [{ ...candidate, projectKeys: [...candidate.projectKeys, ...section.projectKeys] }];
    }
    return [candidate];
  });
  return { ...state, sidebarProjectSections };
}

export function setSidebarProjectSectionExpanded<T extends SidebarLayout>(
  state: T,
  sectionId: string,
  expanded: boolean,
): T {
  const section = state.sidebarProjectSections.find((candidate) => candidate.id === sectionId);
  if (!section || section.collapsed === !expanded) return state;
  return {
    ...state,
    sidebarProjectSections: state.sidebarProjectSections.map((candidate) =>
      candidate.id === sectionId ? { ...candidate, collapsed: !expanded } : candidate,
    ),
  };
}

export function moveProjectToSidebarProjectSection<T extends SidebarLayout>(
  state: T,
  projectKey: string,
  sectionId: string | null,
): T {
  const currentSection = state.sidebarProjectSections.find((section) =>
    section.projectKeys.includes(projectKey),
  );
  if (
    currentSection?.id === sectionId ||
    (sectionId !== null &&
      !state.sidebarProjectSections.some((section) => section.id === sectionId))
  ) {
    return state;
  }
  if (!currentSection && sectionId === null) return state;
  return {
    ...state,
    sidebarProjectSections: state.sidebarProjectSections.map((section) => ({
      ...section,
      projectKeys:
        section.id === sectionId
          ? [...section.projectKeys.filter((key) => key !== projectKey), projectKey]
          : section.projectKeys.filter((key) => key !== projectKey),
    })),
  };
}

export function reorderSidebarProjectSectionProjects<T extends SidebarLayout>(
  state: T,
  sectionId: string,
  projectKeys: readonly string[],
): T {
  const section = state.sidebarProjectSections.find((candidate) => candidate.id === sectionId);
  if (!section) return state;
  const requested = new Set(projectKeys);
  const allowed = new Set(section.projectKeys);
  const nextProjectKeys = [
    ...new Set(projectKeys.filter((key) => allowed.has(key))),
    ...section.projectKeys.filter((key) => !requested.has(key)),
  ];
  if (nextProjectKeys.every((key, index) => key === section.projectKeys[index])) return state;
  let projectIndex = 0;
  return {
    ...state,
    sidebarProjectSections: state.sidebarProjectSections.map((candidate) =>
      candidate.id === sectionId
        ? {
            ...candidate,
            projectKeys: nextProjectKeys,
            ...(candidate.childOrder === undefined
              ? {}
              : {
                  childOrder: sidebarSectionChildOrder(candidate, state.sidebarProjectSections).map(
                    (key) =>
                      candidate.projectKeys.includes(key) ? nextProjectKeys[projectIndex++]! : key,
                  ),
                }),
          }
        : candidate,
    ),
  };
}

export function reorderSidebarProjectSections<T extends SidebarLayout>(
  state: T,
  sectionIds: readonly string[],
): T {
  const requested = new Set(sectionIds);
  const byId = new Map(state.sidebarProjectSections.map((section) => [section.id, section]));
  const nextIds = [
    ...new Set(sectionIds.filter((id) => byId.has(id))),
    ...state.sidebarProjectSections.map((section) => section.id).filter((id) => !requested.has(id)),
  ];
  if (nextIds.every((id, index) => id === state.sidebarProjectSections[index]?.id)) return state;
  return { ...state, sidebarProjectSections: nextIds.map((id) => byId.get(id)!) };
}

export function setProjectExpanded<T extends SidebarLayout>(
  state: T,
  projectIds: string | readonly string[],
  expanded: boolean,
): T {
  const ids = typeof projectIds === "string" ? [projectIds] : projectIds;
  const requested = new Set(ids);
  const openSections = new Set<string>();
  if (expanded)
    for (const section of state.sidebarProjectSections) {
      if (!section.projectKeys.some((id) => requested.has(id))) continue;
      openSections.add(section.id);
      if (section.parentId) openSections.add(section.parentId);
    }
  const nextEntries = ids.filter((id) => state.projectExpandedById[id] !== expanded);
  const opensSection = state.sidebarProjectSections.some(
    (section) => section.collapsed && openSections.has(section.id),
  );
  if (nextEntries.length === 0 && !opensSection) return state;
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      ...Object.fromEntries(nextEntries.map((id) => [id, expanded])),
    },
    sidebarProjectSections: opensSection
      ? state.sidebarProjectSections.map((section) =>
          openSections.has(section.id) ? { ...section, collapsed: false } : section,
        )
      : state.sidebarProjectSections,
  };
}

export function reorderProjects<T extends SidebarLayout>(
  state: T,
  currentProjectOrder: readonly string[],
  draggedProjectIds: readonly string[],
  targetProjectIds: readonly string[],
): T {
  if (draggedProjectIds.length === 0) {
    return state;
  }
  const draggedSet = new Set(draggedProjectIds);
  const targetSet = new Set(targetProjectIds);
  if (draggedProjectIds.every((id) => targetSet.has(id))) {
    return state;
  }

  const originalTargetIndex = currentProjectOrder.findIndex((id) => targetSet.has(id));
  if (originalTargetIndex < 0) {
    return state;
  }

  const projectOrder = [...currentProjectOrder];

  const removed: string[] = [];
  let draggedBeforeTarget = 0;
  for (let i = projectOrder.length - 1; i >= 0; i--) {
    if (draggedSet.has(projectOrder[i]!)) {
      removed.unshift(projectOrder.splice(i, 1)[0]!);
      if (i < originalTargetIndex) {
        draggedBeforeTarget++;
      }
    }
  }
  if (removed.length === 0) {
    return state;
  }

  const insertIndex = originalTargetIndex - Math.max(0, draggedBeforeTarget - 1);
  projectOrder.splice(insertIndex, 0, ...removed);
  return {
    ...state,
    projectOrder,
  };
}

/** Pure operations shared by optimistic clients and the locked sidebar service. */
function applyMutation(
  current: SidebarLayout | undefined,
  mutation: SidebarLayoutMutation,
): SidebarLayout | undefined {
  if (mutation.type === "migrate") {
    const state = current ?? EMPTY_SIDEBAR_LAYOUT;
    const importedIds = new Set(
      mutation.layout.sidebarProjectSections.map((section) => section.id),
    );
    const importedProjects = new Set(
      mutation.layout.sidebarProjectSections.flatMap((section) => section.projectKeys),
    );
    return {
      ...mutation.layout,
      sidebarProjectSections: [
        ...mutation.layout.sidebarProjectSections,
        ...state.sidebarProjectSections
          .filter((section) => !importedIds.has(section.id))
          .map((section) => ({
            ...section,
            projectKeys: section.projectKeys.filter((id) => !importedProjects.has(id)),
          })),
      ],
      projectExpandedById: { ...state.projectExpandedById, ...mutation.layout.projectExpandedById },
      projectOrder: [...new Set([...mutation.layout.projectOrder, ...state.projectOrder])],
    };
  }
  const state = current ?? EMPTY_SIDEBAR_LAYOUT;
  switch (mutation.type) {
    case "add":
      return addSidebarProjectSection(state, mutation.section);
    case "rename":
      return renameSidebarProjectSection(state, mutation.sectionId, mutation.name);
    case "color":
      return setSidebarProjectSectionColor(state, mutation.sectionId, mutation.color);
    case "folderIcons":
      return setSidebarProjectSectionFolderIcons(state, mutation.sectionId, mutation.folderIcons);
    case "delete":
      return deleteSidebarProjectSection(state, mutation.sectionId);
    case "sectionExpanded":
      return setSidebarProjectSectionExpanded(state, mutation.sectionId, mutation.expanded);
    case "move": {
      if (
        mutation.sectionId !== null &&
        !state.sidebarProjectSections.some((section) => section.id === mutation.sectionId)
      )
        return state;
      let next = state;
      for (const key of mutation.projectKeys)
        next = moveProjectToSidebarProjectSection(next, key, mutation.sectionId);
      if (mutation.expanded !== undefined) {
        next = setProjectExpanded(next, mutation.projectKeys, mutation.expanded);
      }
      return next;
    }
    case "sectionProjectsOrder":
      return reorderSidebarProjectSectionProjects(state, mutation.sectionId, mutation.projectKeys);
    case "sectionChildrenOrder": {
      const section = state.sidebarProjectSections.find((s) => s.id === mutation.sectionId);
      if (!section) return state;
      const childOrder = sidebarSectionChildOrder(
        { ...section, childOrder: mutation.childOrder },
        state.sidebarProjectSections,
      );
      const projects = new Set(section.projectKeys);
      return {
        ...state,
        sidebarProjectSections: state.sidebarProjectSections.map((s) =>
          s.id === section.id
            ? { ...s, childOrder, projectKeys: childOrder.filter((key) => projects.has(key)) }
            : s,
        ),
      };
    }
    case "sectionsOrder":
      return reorderSidebarProjectSections(state, mutation.sectionIds);
    case "projectExpanded":
      return setProjectExpanded(state, mutation.projectKeys, mutation.expanded);
    case "otherExpanded":
      return setSidebarOtherProjectsExpanded(state, mutation.expanded);
    case "projectsOrder":
      return reorderProjects(
        state,
        mutation.currentProjectOrder,
        mutation.draggedProjectIds,
        mutation.targetProjectIds,
      );
    case "organize": {
      const organized = organizeSectionsByFolder({
        sections: state.sidebarProjectSections,
        projects: mutation.projects,
        root: mutation.root,
        onlyUnsorted: mutation.onlyUnsorted,
        makeId: (name, parentId) => "folder:" + mutation.root + ":" + (parentId ?? "") + ":" + name,
      });
      return organized.changed ? { ...state, sidebarProjectSections: organized.sections } : state;
    }
  }
}

/** Missing or stale entries keep their existing order; old layouts show subsections first. */
export function sidebarSectionChildOrder(
  section: {
    readonly id: string;
    readonly projectKeys: readonly string[];
    readonly childOrder?: readonly string[] | undefined;
  },
  subsections: readonly { readonly id: string; readonly parentId?: string | undefined }[],
): string[] {
  const fallback = [
    ...subsections.filter((s) => s.parentId === section.id).map((s) => `section:${s.id}`),
    ...section.projectKeys,
  ];
  const allowed = new Set(fallback);
  return [
    ...new Set([...(section.childOrder ?? []).filter((key) => allowed.has(key)), ...fallback]),
  ];
}

/** Keep explicit orders free of deleted or moved children after every mutation. */
export function applySidebarLayoutMutation(
  current: SidebarLayout | undefined,
  mutation: SidebarLayoutMutation,
): SidebarLayout | undefined {
  const next = applyMutation(current, mutation);
  if (!next || next === current) return next;
  return {
    ...next,
    sidebarProjectSections: next.sidebarProjectSections.map((section) =>
      section.childOrder === undefined
        ? section
        : {
            ...section,
            childOrder: sidebarSectionChildOrder(section, next.sidebarProjectSections),
          },
    ),
  };
}
