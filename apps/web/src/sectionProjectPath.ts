import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import type { FilesystemBrowseEntry } from "@t3tools/contracts";
import {
  isHostPath,
  isWindowsAbsolutePath,
  normalizeProjectPathForComparison,
} from "@t3tools/shared/path";

/**
 * Where a section's projects live on disk: <root>/<Section> or <root>/<Section>/<Subsection>, the
 * same layout Organize by folder reads. The destination environment expands home paths.
 */
export function sectionFolderPath(
  root: string,
  sectionNames: readonly string[],
  folderPath?: string,
): string | null {
  if (folderPath) return folderPath;
  const trimmed = root.trim();
  if (
    (trimmed !== "~" && !isHostPath(trimmed)) ||
    /^[A-Za-z]:$/.test(trimmed) ||
    sectionNames.some((name) => projectFolderNameProblem(name) !== null)
  )
    return null;
  const windows = isWindowsAbsolutePath(trimmed);
  const base = windows
    ? trimmed.replaceAll("/", "\\").replace(/\\+$/, "")
    : trimmed.replace(/\/+$/, "");
  return [base, ...sectionNames.map((name) => name.trim())].join(windows ? "\\" : "/");
}

/** Why a new project folder name can't be used, or null when it can. */
export function projectFolderNameProblem(
  name: string,
  resolve: MessageResolver = m,
): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return resolve(msg("Enter a name."));
  if (trimmed === "." || trimmed === "..") return resolve(msg("Choose a different name."));
  if (/[/\\\0]/.test(trimmed)) return resolve(msg("A name can't contain slashes."));
  return null;
}

/** Preserve the chosen folder independently of the subsection's renamable label. */
export function folderSubsectionInput(path: string) {
  const folderPath = path.trim().replace(/[/\\]+$/, "");
  const name = folderPath.split(/[/\\]/).at(-1) ?? "";
  if (projectFolderNameProblem(name) !== null || /^[A-Za-z]:$/.test(name)) return null;
  return { name: name.slice(0, 80), folderPath };
}

export function suggestSectionFolder(
  name: string,
  folders: readonly FilesystemBrowseEntry[],
  isPending: boolean,
) {
  if (isPending) return "pending";
  const trimmed = name.trim();
  return folders.find((folder) => folder.name === trimmed) ?? null;
}

export function sectionProjectCandidates(
  folders: readonly FilesystemBrowseEntry[],
  projectPaths: readonly string[],
) {
  const added = new Set(projectPaths.map(normalizeProjectPathForComparison));
  return folders.filter(
    (folder) =>
      !folder.name.startsWith(".") &&
      !added.has(normalizeProjectPathForComparison(folder.fullPath)),
  );
}
