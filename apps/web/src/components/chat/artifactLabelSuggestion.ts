export function artifactLabelSuggestion(path: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const stem = name.replace(/\.[^.]+$/, "") || name;
  const word = stem.split(/[\s._-]+/).find(Boolean) ?? stem;
  return word.charAt(0).toUpperCase() + word.slice(1);
}
