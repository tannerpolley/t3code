import type { ThreadLinkedIssue } from "@t3tools/contracts";
import * as Config from "effect/Config";

/** Repositories whose managed issue workers publish and merge their own PR. */
export const IssueDraftPrRepositories = Config.String("T3CODE_ISSUE_DRAFT_PR_REPOSITORIES").pipe(
  Config.withDefault(""),
  Config.map(
    (value): ReadonlySet<string> =>
      new Set(
        value
          .toLowerCase()
          .split(",")
          .map((key) => key.trim()),
      ),
  ),
);

export const isDraftPrRepository = (
  repositories: ReadonlySet<string>,
  issue: Pick<ThreadLinkedIssue, "host" | "repository">,
) => repositories.has(`${issue.host}/${issue.repository}`.toLowerCase());

export const issueWorkerBrief = (issue: ThreadLinkedIssue, canPublishDraft: boolean) => {
  const repository = `${issue.host}/${issue.repository}`;
  const publishing = canPublishDraft
    ? `The repository owner explicitly requests that you publish and merge after checks pass. First have a fresh read-only reviewer subagent review this worktree's diff against the issue, and fix its blockers. Then push only this issue branch to ${repository} and open the PR there ready for review, or mark an existing draft ready, with Closes #${issue.number} and the review verdict in the body; if blockers remain, keep any PR a draft and report them instead. Once the PR is ready and mergeable, merge it with gh pr merge --rebase, or --squash when the branch contains merge commits. If main moved and the PR conflicts, merge origin/main into the branch, re-run your checks, push, and retry. Then report the merge SHA and finish. Force-pushing, issue edits, and other GitHub mutations retain separate approval.`
    : "Other GitHub mutations and publishing retain separate approval.";
  return `Implement issue #${issue.number}: ${issue.title}\n${issue.url}\nRead the issue and its comments, complete the authorized work, and report the result. Status and closeout comments are authorized. ${publishing}`;
};
