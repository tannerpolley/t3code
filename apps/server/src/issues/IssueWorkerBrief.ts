import type { ThreadLinkedIssue } from "@t3tools/contracts";

export const issueWorkerBrief = (issue: ThreadLinkedIssue, canPublishDraft: boolean) => {
  const repository = `${issue.host}/${issue.repository}`;
  const publishing = canPublishDraft
    ? `The repository owner explicitly requests that you publish after checks pass. Push only this issue branch to ${repository} and open or update a draft PR there with Closes #${issue.number} in the body. Merging, force-pushing, issue edits, and other GitHub mutations retain separate approval.`
    : "Other GitHub mutations and publishing retain separate approval.";
  return `Implement issue #${issue.number}: ${issue.title}\n${issue.url}\nRead the issue and its comments, complete the authorized work, and report the result. Status and closeout comments are authorized. ${publishing}`;
};
