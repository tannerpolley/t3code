import { sanitizeBranchFragment } from "@t3tools/shared/git";

export { findIssueProject } from "@t3tools/client-runtime/state/issue-work";

/** `issue-<number>-<title slug>`: one ref segment, lowercase, git-safe. */
export function issueWorktreeBranchName(number: number, title: string): string {
  return sanitizeBranchFragment(`issue-${number}-${title.replaceAll("/", " ")}`);
}
