/** A rendered sidebar section as the drop logic sees it; `custom` is false for "Other projects". */
export interface ProjectDropSection {
  readonly id: string;
  readonly custom: boolean;
  readonly projectKeys: readonly string[];
}

/** What a dragged project is over: another project, or a section's header or body. */
export type ProjectDropOver =
  | { readonly type: "project"; readonly projectKey: string }
  | { readonly type: "section"; readonly sectionId: string };

export interface ProjectDrop {
  /** The rendered section that receives the project. */
  readonly sectionId: string;
  /** The receiving section's order after the drop; null for "Other projects", which is unordered. */
  readonly projectKeys: readonly string[] | null;
  /** The project the drop line sits above: null for the section's end, undefined for no line. */
  readonly beforeKey: string | null | undefined;
}

export interface ProjectThreadSection {
  readonly id: string;
  readonly parentId?: string;
  readonly projectKeys: readonly string[];
  readonly collapsed: boolean;
}

/**
 * Thread rows in the Projects view's visible order. The Activity view has its own
 * shelves and paging; this list follows section, subsection, project, then thread order.
 */
export function collectVisibleProjectThreadOrder<TThread>(input: {
  readonly projects: readonly { readonly projectKey: string }[];
  readonly sections: readonly ProjectThreadSection[];
  readonly otherProjectsExpanded: boolean;
  readonly isProjectExpanded: (projectKey: string) => boolean;
  readonly threadsByProjectKey: ReadonlyMap<string, readonly TThread[]>;
  readonly getThreadKey: (thread: TThread) => string;
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
    for (const thread of input.threadsByProjectKey.get(projectKey) ?? []) {
      threadKeys.push(input.getThreadKey(thread));
    }
  };

  for (const section of visibleSections) {
    if (section.parentId !== undefined || section.collapsed) continue;
    for (const subsection of visibleSections) {
      if (subsection.parentId === section.id && !subsection.collapsed) {
        subsection.projectKeys.forEach(appendProjectThreads);
      }
    }
    section.projectKeys.forEach(appendProjectThreads);
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
  const target =
    over.type === "project"
      ? sections.find((section) => section.projectKeys.includes(over.projectKey))
      : sections.find((section) => section.id === over.sectionId);
  if (target === undefined) return null;
  const alreadyThere = target.projectKeys.includes(projectKey);

  if (!target.custom) {
    return alreadyThere ? null : { sectionId: target.id, projectKeys: null, beforeKey: undefined };
  }

  const others = target.projectKeys.filter((key) => key !== projectKey);
  let index = others.length;
  if (over.type === "project") {
    index = others.indexOf(over.projectKey);
    // Moving down within a section lands below the row under the pointer, as a list reorder does.
    const movingDown =
      alreadyThere &&
      target.projectKeys.indexOf(projectKey) < target.projectKeys.indexOf(over.projectKey);
    if (movingDown) index += 1;
  }
  const projectKeys = [...others.slice(0, index), projectKey, ...others.slice(index)];
  if (alreadyThere && projectKeys.every((key, position) => key === target.projectKeys[position])) {
    return null;
  }
  return { sectionId: target.id, projectKeys, beforeKey: others[index] ?? null };
}
