/**
 * Where a section's projects live on disk: <root>/<Section> or <root>/<Section>/<Subsection>, the
 * same layout Organize by folder reads. Null without a full root path.
 */
export function sectionFolderPath(root: string, sectionNames: readonly string[]): string | null {
  const trimmed = root.trim().replace(/\/+$/, "");
  if (!trimmed.startsWith("/")) return null;
  return [trimmed, ...sectionNames].join("/");
}

/** Why a new project folder name can't be used, or null when it can. */
export function projectFolderNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Enter a name.";
  if (trimmed === "." || trimmed === "..") return "Choose a different name.";
  if (/[/\\\0]/.test(trimmed)) return "A name can't contain slashes.";
  return null;
}
