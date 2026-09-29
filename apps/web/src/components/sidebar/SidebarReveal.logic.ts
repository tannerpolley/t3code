/** A thread as the reveal sees it; the sidebar builds it from its thread shells. */
export interface RevealThread {
  /** The thread's parent, when the sidebar shows it under that parent instead of as its own row. */
  readonly parentKey: string | null;
  /** The logical project holding the thread, or null when the sidebar has no such project. */
  readonly projectKey: string | null;
  readonly archived: boolean;
}

export interface RevealSection {
  readonly id: string;
  readonly parentId?: string;
  readonly collapsed: boolean;
  readonly projectKeys: readonly string[];
}

/** What to open, and which row to scroll to, so the Projects view shows a thread. */
export interface SidebarReveal {
  /** The thread whose row is on screen: the top-level parent for a subagent. */
  readonly rowKey: string;
  readonly projectKey: string;
  /** Collapsed custom sections, outermost last, that hide the project. */
  readonly expandSectionIds: readonly string[];
  readonly expandOtherProjects: boolean;
  readonly expandProject: boolean;
}

/**
 * The reveal for `threadKey`, or null when the sidebar has no row for it (unknown, archived, or
 * not yet loaded). An already visible thread yields nothing to expand. Follows the first section
 * that lists the project, as the sidebar does; projects in no section sit under "Other projects".
 */
export function resolveSidebarReveal(input: {
  readonly threadKey: string;
  readonly getThread: (threadKey: string) => RevealThread | undefined;
  readonly sections: readonly RevealSection[];
  readonly otherProjectsExpanded: boolean;
  readonly isProjectExpanded: (projectKey: string) => boolean;
}): SidebarReveal | null {
  const seen = new Set<string>();
  let rowKey = input.threadKey;
  let row = input.getThread(rowKey);
  while (row?.parentKey != null && !seen.has(rowKey)) {
    seen.add(rowKey);
    rowKey = row.parentKey;
    row = input.getThread(rowKey);
  }
  if (row === undefined || row.parentKey !== null || row.archived || row.projectKey === null) {
    return null;
  }
  const projectKey = row.projectKey;
  const owner = input.sections.find((section) => section.projectKeys.includes(projectKey));
  const parent =
    owner?.parentId === undefined
      ? undefined
      : input.sections.find((section) => section.id === owner.parentId);
  return {
    rowKey,
    projectKey,
    expandSectionIds: [owner, parent].flatMap((section) =>
      section?.collapsed ? [section.id] : [],
    ),
    expandOtherProjects: owner === undefined && !input.otherProjectsExpanded,
    expandProject: !input.isProjectExpanded(projectKey),
  };
}
