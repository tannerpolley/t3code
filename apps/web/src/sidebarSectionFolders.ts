import type { SidebarProjectSection } from "./uiStateStore";

/** A sidebar project and the folders its checkouts live in. */
export interface FolderOrganizedProject {
  readonly projectKey: string;
  readonly workspaceRoots: readonly string[];
}

function trimTrailingSlashes(path: string): string {
  return path.trim().replace(/\/+$/, "");
}

function isInside(path: string, folder: string): boolean {
  return path.startsWith(`${folder}/`);
}

/**
 * Arranges sections to mirror the folders under `root`: a project in `root/A/B/project` lands in
 * section A, subsection B; deeper folders fold into B. Existing sections are reused by name, so
 * running it again only moves what changed. A project inside another project's folder (a
 * superproject with submodules) goes wherever that project goes. Projects directly in `root`, or
 * outside it, keep their current place.
 */
export function organizeSectionsByFolder(input: {
  readonly sections: readonly SidebarProjectSection[];
  readonly projects: readonly FolderOrganizedProject[];
  readonly root: string;
  readonly makeId: () => string;
}): SidebarProjectSection[] {
  const root = trimTrailingSlashes(input.root);
  if (root.length === 0) return [...input.sections];
  const sections = input.sections.map((section) => ({
    ...section,
    projectKeys: [...section.projectKeys],
  }));

  const findOrCreate = (name: string, parentId: string | undefined): SidebarProjectSection => {
    const existing = sections.find(
      (section) =>
        section.parentId === parentId && section.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) return existing;
    const created: SidebarProjectSection = {
      id: input.makeId(),
      name,
      projectKeys: [],
      collapsed: false,
      ...(parentId === undefined ? {} : { parentId }),
    };
    sections.push(created);
    return created;
  };

  // Shallowest first, so a superproject is placed before the projects inside it.
  const located = input.projects
    .flatMap((project) => {
      const path = project.workspaceRoots
        .map(trimTrailingSlashes)
        .filter((candidate) => isInside(candidate, root))
        .toSorted((left, right) => left.length - right.length)[0];
      return path === undefined ? [] : [{ projectKey: project.projectKey, path }];
    })
    .toSorted((left, right) => left.path.length - right.path.length);

  const placements = new Map<string, string>();
  for (const project of located) {
    const superproject = located
      .filter((other) => other !== project && isInside(project.path, other.path))
      .toSorted((left, right) => right.path.length - left.path.length)[0];
    if (superproject) {
      const target = placements.get(superproject.projectKey);
      if (target) placements.set(project.projectKey, target);
      continue;
    }
    const folders = project.path
      .slice(root.length + 1)
      .split("/")
      .slice(0, -1);
    if (folders.length === 0) continue;
    const section = findOrCreate(folders[0]!, undefined);
    const target = folders[1] === undefined ? section : findOrCreate(folders[1], section.id);
    placements.set(project.projectKey, target.id);
  }

  for (const [projectKey, sectionId] of placements) {
    for (const section of sections) {
      if (section.id === sectionId) {
        if (!section.projectKeys.includes(projectKey)) section.projectKeys.push(projectKey);
      } else {
        section.projectKeys = section.projectKeys.filter((key) => key !== projectKey);
      }
    }
  }
  return sections;
}
