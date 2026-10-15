import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { IssueListResult } from "@t3tools/contracts";
import { issuePullRequests } from "@t3tools/shared/issuePullRequests";
import {
  legacyThreadPullRequestKey,
  threadPullRequestKeyOf,
} from "@t3tools/shared/threadPullRequests";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";

/** Overlay cached GitHub metadata with the sidebar's streamed shells, including new descendants. */
export function withLiveIssueWork(
  list: IssueListResult,
  shells: readonly EnvironmentThreadShell[],
): IssueListResult {
  const active = shells.filter((thread) => thread.archivedAt === null);
  const byId = new Map(active.map((thread) => [thread.id, thread]));
  const scope = `${list.repository.host}/${list.repository.repository}`.toLowerCase();
  return {
    ...list,
    issues: list.issues.map((issue) => {
      const associated = new Set((issue.liveWork ?? []).map((work) => work.threadId));
      const closing = new Set((issue.pullRequests ?? []).map(threadPullRequestKeyOf));
      for (const thread of active) {
        const linked = thread.linkedIssue;
        if (
          linked !== undefined &&
          linked.number === issue.number &&
          `${linked.host}/${linked.repository}`.toLowerCase() === scope
        )
          associated.add(thread.id);
        if (
          thread.linkedPullRequest != null &&
          closing.has(threadPullRequestKeyOf(legacyThreadPullRequestKey(thread.linkedPullRequest)))
        )
          associated.add(thread.id);
      }
      const linkedThreads = active.filter((thread) => {
        let current: EnvironmentThreadShell | undefined = thread;
        const visited = new Set<string>();
        while (current !== undefined && !visited.has(current.id)) {
          if (associated.has(current.id)) return true;
          visited.add(current.id);
          current =
            current.lineage.parentThreadId === null
              ? undefined
              : byId.get(current.lineage.parentThreadId);
        }
        return false;
      });
      const liveWork = linkedThreads.map((thread) => {
        const sidebarStatus = resolveSidebarThreadStatus(thread);
        return {
          threadId: thread.id,
          title: thread.title,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          pullRequests: thread.pullRequests
            .filter((pr) => pr.source !== "stack-dismissed")
            .map((pr) => pr.url),
          status:
            sidebarStatus === "working"
              ? ("working" as const)
              : sidebarStatus === "approval" || sidebarStatus === "input"
                ? ("waiting_on_you" as const)
                : ("idle" as const),
        };
      });
      const pullRequests = issuePullRequests(
        issue.pullRequests ?? [],
        linkedThreads.flatMap((thread) => thread.pullRequests),
      );
      return { ...issue, liveWork, pullRequests, pullRequestCount: pullRequests.length };
    }),
  };
}
