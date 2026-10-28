import type { IssueQueueEntry } from "@t3tools/contracts";

export const issueQueueMessage = (entry: IssueQueueEntry) =>
  `Queued issue #${entry.issue.number}: ${entry.issue.title}\n${entry.issue.url}\n\nReview this issue against the current code and the repository's other issues first. Use get_repository_orchestration for the queue. Options: start as written; edit the issue on GitHub, then start; close it on GitHub as done (comment where it landed) or not planned (comment why); or keep it open and withdraw it with unqueue_issue. To start a managed worker, use delegate_task with issue argument: ${JSON.stringify({ host: entry.issue.host, repository: entry.issue.repository, number: entry.issue.number })}.`;
