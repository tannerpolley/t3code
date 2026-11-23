import type { ThreadLinkedIssue } from "@t3tools/contracts";

export const issueWorkerBrief = (issue: ThreadLinkedIssue, canPublishDraft: boolean) => {
  const repository = `${issue.host}/${issue.repository}`;
  const publishing = canPublishDraft
    ? `The repository owner explicitly requests that you publish after checks pass. First have a fresh read-only reviewer subagent review this worktree's diff against the issue, and fix its blockers. Then push only this issue branch to ${repository} and open the PR there ready for review, or mark an existing draft ready, with Closes #${issue.number} and the review verdict in the body; if blockers remain, keep any PR a draft and report them instead. Merging, force-pushing, issue edits, and other GitHub mutations retain separate approval.`
    : "Other GitHub mutations and publishing retain separate approval.";
  return `Implement issue #${issue.number}: ${issue.title}\n${issue.url}\nRead the issue and its comments, complete the authorized work, and report the result. Status and closeout comments are authorized. ${publishing}`;
};
