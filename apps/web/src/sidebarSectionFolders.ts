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
  /** Place only projects in no section yet, leaving ones sorted by hand where they are. */
  readonly onlyUnsorted?: boolean;
}): { readonly sections: SidebarProjectSection[]; readonly changed: boolean } {
  const root = trimTrailingSlashes(input.root);
  const unchanged = { sections: [...input.sections], changed: false };
  if (root.length === 0) return unchanged;

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

  // Each project's section folders: [section] or [section, subsection].
  const foldersByKey = new Map<string, readonly string[]>();
  for (const project of located) {
    const superproject = located
      .filter((other) => other !== project && isInside(project.path, other.path))
      .toSorted((left, right) => right.path.length - left.path.length)[0];
    if (superproject) {
      const inherited = foldersByKey.get(superproject.projectKey);
      if (inherited) foldersByKey.set(project.projectKey, inherited);
      continue;
    }
    const folders = project.path
      .slice(root.length + 1)
      .split("/")
      .slice(0, -1)
      .slice(0, 2);
    if (folders.length > 0) foldersByKey.set(project.projectKey, folders);
  }

  const sorted = new Set(input.sections.flatMap((section) => section.projectKeys));
  const moves = [...foldersByKey].filter(
    ([projectKey]) => !input.onlyUnsorted || !sorted.has(projectKey),
  );
  if (moves.length === 0) return unchanged;

  const sections = input.sections.map((section) => ({
    ...section,
    projectKeys: [...section.projectKeys],
  }));
  let changed = false;
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
    changed = true;
    return created;
  };

  for (const [projectKey, folders] of moves) {
    const section = findOrCreate(folders[0]!, undefined);
    const target = folders[1] === undefined ? section : findOrCreate(folders[1], section.id);
    for (const candidate of sections) {
      const has = candidate.projectKeys.includes(projectKey);
      if (candidate.id === target.id && !has) {
        candidate.projectKeys.push(projectKey);
        changed = true;
      } else if (candidate.id !== target.id && has) {
        candidate.projectKeys = candidate.projectKeys.filter((key) => key !== projectKey);
        changed = true;
      }
    }
  }
  return changed ? { sections, changed } : unchanged;
}
