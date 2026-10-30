/**
 * The plain name of a worktree T3 creates for an agent: `issue-<number>-<title slug>`
 * for issue work, otherwise a short slug of the title. One ref segment, so the
 * worktree folder reads the same. Callers add `-2`, `-3` on collision.
 */
export function formatAgentWorktreeName(title: string, slug: string, issueNumber?: number): string {
  // Cut at a word boundary; a single long word is cut hard.
  const short = (slug.length <= 40 ? slug : slug.slice(0, 41).replace(/-[^-]*$/, ""))
    .slice(0, 40)
    .replace(/-+$/, "");
  if (issueNumber === undefined) return short;
  // An untitled issue would otherwise read `issue-<number>-update`.
  return /[a-z0-9]/i.test(title) ? `issue-${issueNumber}-${short}` : `issue-${issueNumber}`;
}
