import { effectiveThreadRole } from "@t3tools/contracts";
import { sidebarSectionChildOrder } from "@t3tools/shared/sidebarLayout";
import type { SidebarThreadSummary } from "../../types";
import { collectDisplayedFamilyRows } from "./SidebarFamilySeparators.logic";

/** A rendered sidebar section as the drop logic sees it; `custom` is false for "Other projects". */
export interface ProjectDropSection {
  readonly id: string;
  readonly custom: boolean;
  readonly parentId?: string | undefined;
  readonly childOrder?: readonly string[] | undefined;
  readonly projectKeys: readonly string[];
}

/** What a dragged project is over: another project, or a section's header or body. */
export type ProjectDropOver =
  | { readonly type: "project"; readonly projectKey: string }
  | { readonly type: "section" | "section-header"; readonly sectionId: string };

export interface ProjectDrop {
  /** The rendered section that receives the project. */
  readonly sectionId: string;
  /** Receiving project order; null when the drop does not order projects. */
  readonly projectKeys: readonly string[] | null;
  readonly childOrder?: readonly string[];
  /** The project the drop line sits above: null for the section's end, undefined for no line. */
  readonly beforeKey: string | null | undefined;
}

export interface ProjectThreadSection {
  readonly id: string;
  readonly parentId?: string;
  readonly childOrder?: readonly string[];
  readonly projectKeys: readonly string[];
  readonly collapsed: boolean;
}

/** A project's orchestrators lead its threads; the rest keep the Thread order setting's order. */
export function orchestratorsFirst<T extends Parameters<typeof effectiveThreadRole>[0]>(
  threads: readonly T[],
): T[] {
  const lead = (thread: T) => (effectiveThreadRole(thread) === "orchestrator" ? 0 : 1);
  return [...threads].sort((a, b) => lead(a) - lead(b));
}

/**
 * Thread rows in the Projects view's visible order. The Activity view has its own
 * shelves and paging; this list follows section, subsection, project, then thread order.
 */
export function collectVisibleProjectThreadOrder(input: {
  readonly projects: readonly { readonly projectKey: string }[];
  readonly sections: readonly ProjectThreadSection[];
  readonly otherProjectsExpanded: boolean;
  readonly isProjectExpanded: (projectKey: string) => boolean;
  readonly threadsByProjectKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>;
  readonly runningSubagentsByParentKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>;
  readonly expandedByKey: Readonly<Record<string, boolean>>;
}): string[] {
  const projectKeys = new Set(input.projects.map((project) => project.projectKey));
  const claimedProjectKeys = new Set<string>();
  const visibleSections = input.sections.map((section) => ({
    ...section,
    projectKeys: section.projectKeys.filter((projectKey) => {
      if (!projectKeys.has(projectKey) || claimedProjectKeys.has(projectKey)) return false;
      claimedProjectKeys.add(projectKey);
      return true;
    }),
  }));
  const threadKeys: string[] = [];
  const appendProjectThreads = (projectKey: string) => {
    if (!input.isProjectExpanded(projectKey)) return;
    for (const row of collectDisplayedFamilyRows({
      threads: input.threadsByProjectKey.get(projectKey) ?? [],
      runningSubagentsByParentKey: input.runningSubagentsByParentKey,
      expandedByKey: input.expandedByKey,
    })) {
      if (row.thread !== null) threadKeys.push(row.key);
    }
  };

  for (const section of visibleSections) {
    if (section.parentId !== undefined || section.collapsed) continue;
    for (const key of sidebarSectionChildOrder(section, visibleSections)) {
      if (!key.startsWith("section:")) {
        appendProjectThreads(key);
        continue;
      }
      const subsection = visibleSections.find((s) => s.id === key.slice(8));
      if (subsection && !subsection.collapsed) subsection.projectKeys.forEach(appendProjectThreads);
    }
  }

  if (input.otherProjectsExpanded) {
    for (const project of input.projects) {
      if (!claimedProjectKeys.has(project.projectKey)) appendProjectThreads(project.projectKey);
    }
  }
  return threadKeys;
}

/**
 * Where dropping `projectKey` now would put it, or null when nothing would change. The drop line
 * and the drop itself both read this, so the line always shows the real landing spot.
 */
export function resolveProjectDrop(input: {
  readonly projectKey: string;
  readonly over: ProjectDropOver;
  readonly sections: readonly ProjectDropSection[];
}): ProjectDrop | null {
  const { projectKey, over, sections } = input;
  if (over.type === "project" && over.projectKey === projectKey) return null;
  let target =
    over.type === "project"
      ? sections.find((section) => section.projectKeys.includes(over.projectKey))
      : sections.find((section) => section.id === over.sectionId);
  if (target === undefined) return null;
  let overKey = over.type === "project" ? over.projectKey : undefined;
  // A sibling header reorders; its body still accepts projects into the subsection.
  if (over.type === "section-header" && target.parentId !== undefined) {
    const parentId = target.parentId;
    const parent = sections.find((s) => s.id === parentId);
    if (parent?.projectKeys.includes(projectKey)) {
      overKey = `section:${target.id}`;
      target = parent;
    }
  }
  const alreadyThere = target.projectKeys.includes(projectKey);
  if (!target.custom) {
    return alreadyThere ? null : { sectionId: target.id, projectKeys: null, beforeKey: undefined };
  }
  const order = sidebarSectionChildOrder(target, sections);
  const others = order.filter((key) => key !== projectKey);
  let index = others.length;
  if (overKey !== undefined) {
    index = others.indexOf(overKey);
    if (index < 0) return null;
    if (alreadyThere && order.indexOf(projectKey) < order.indexOf(overKey)) index += 1;
  }
  const childOrder = [...others.slice(0, index), projectKey, ...others.slice(index)];
  if (alreadyThere && childOrder.every((key, position) => key === order[position])) return null;
  const projects = new Set([...target.projectKeys, projectKey]);
  const projectKeys = childOrder.filter((key) => projects.has(key));
  const mixed = target.childOrder !== undefined || sections.some((s) => s.parentId === target.id);
  return {
    sectionId: target.id,
    projectKeys,
    beforeKey: others[index] ?? null,
    ...(mixed ? { childOrder } : {}),
  };
}

export function resolveSubsectionDrop(
  sectionId: string,
  over: ProjectDropOver,
  sections: readonly ProjectDropSection[],
): ProjectDrop | null {
  const section = sections.find((s) => s.id === sectionId);
  const parent = sections.find((s) => s.id === section?.parentId);
  if (!parent) return null;
  const target =
    over.type === "project"
      ? sections.find((s) => s.projectKeys.includes(over.projectKey))
      : sections.find((s) => s.id === over.sectionId);
  if (!target) return null;
  const overKey =
    target.id === parent.id && over.type === "project"
      ? over.projectKey
      : target.parentId === parent.id
        ? `section:${target.id}`
        : undefined;
  if (overKey === undefined) return null;
  const key = `section:${sectionId}`;
  const order = sidebarSectionChildOrder(parent, sections);
  const from = order.indexOf(key),
    to = order.indexOf(overKey);
  if (from < 0 || to < 0 || from === to) return null;
  const childOrder = [...order];
  childOrder.splice(from, 1);
  childOrder.splice(to, 0, key);
  return {
    sectionId: parent.id,
    childOrder,
    projectKeys: null,
    beforeKey: childOrder[to + 1] ?? null,
  };
}
