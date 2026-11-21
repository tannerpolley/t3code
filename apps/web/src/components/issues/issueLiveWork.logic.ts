import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  RepositoryIssueListResult,
  IssueRepositoryRef,
  RepositoryIssueSummary,
  IssuePullRequestStatus,
  ThreadId,
} from "@t3tools/contracts";
import { managedImplementorAwaitingSubagent } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { issuePullRequests } from "@t3tools/source-control-definitions/issuePullRequests";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";

const scopeKey = (environmentId: EnvironmentId, scope: IssueRepositoryRef) =>
  `${environmentId}:${scope.host.toLowerCase()}/${scope.repository.toLowerCase()}`;
const threadKey = (environmentId: EnvironmentId, id: string) => `${environmentId}:${id}`;
const sameItems = <T>(left: readonly T[], right: readonly T[]) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

/** Built once per shell update, shared by all issue surfaces. No issue-by-thread scans. */
export function indexIssueWork(
  shells: readonly EnvironmentThreadShell[],
  removedAt?: ReadonlyMap<EnvironmentId, ReadonlyMap<ThreadId, number>>,
) {
  const threads = new Map<string, EnvironmentThreadShell>();
  const issues = new Map<string, Map<number, EnvironmentThreadShell[]>>();
  for (const thread of shells) {
    threads.set(threadKey(thread.environmentId, thread.id), thread);
    if (thread.linkedIssue === undefined) continue;
    const key = scopeKey(thread.environmentId, thread.linkedIssue);
    let repository = issues.get(key);
    if (repository === undefined) issues.set(key, (repository = new Map()));
    const linked = repository.get(thread.linkedIssue.number) ?? [];
    linked.push(thread);
    repository.set(thread.linkedIssue.number, linked);
  }
  return { threads, issues, removedAt };
}
type IssueWorkIndex = ReturnType<typeof indexIssueWork>;
type WorkSummary = Pick<RepositoryIssueSummary, "number"> & {
  readonly state?: RepositoryIssueSummary["state"];
  readonly liveWork?:
    | readonly (Pick<
        NonNullable<RepositoryIssueSummary["liveWork"]>[number],
        "threadId" | "inherited" | "status" | "paused" | "worktreeExists"
      > &
        Partial<
          Pick<
            NonNullable<RepositoryIssueSummary["liveWork"]>[number],
            "worktreePath" | "pullRequests"
          >
        >)[]
    | undefined;
  readonly closingPullRequests?: readonly IssuePullRequestStatus[] | undefined;
  readonly pullRequests?: readonly IssuePullRequestStatus[] | undefined;
};

/** Cache only associated rows; unchanged shells keep the same issue and list objects. */
export function createLiveIssueWorkOverlay() {
  const summaries = new WeakMap<
    WorkSummary,
    Map<
      string,
      {
        threads: readonly (EnvironmentThreadShell | undefined | null)[];
        result: WorkSummary;
      }
    >
  >();
  const lists = new WeakMap<
    RepositoryIssueListResult,
    Map<
      EnvironmentId,
      {
        result: RepositoryIssueListResult;
        associated: Set<number>;
        positions: Map<number, number>;
      }
    >
  >();

  const summary = <T extends WorkSummary>(
    issue: T,
    scope: IssueRepositoryRef,
    environmentId: EnvironmentId,
    index: IssueWorkIndex,
  ): T => {
    // Older servers lack the provenance needed to safely replace their work and PR counts.
    if (issue.closingPullRequests === undefined) return issue;
    const key = scopeKey(environmentId, scope);
    const ids = new Set((issue.liveWork ?? []).map((work) => work.threadId));
    for (const thread of index.issues.get(key)?.get(issue.number) ?? []) ids.add(thread.id);
    const removed = index.removedAt?.get(environmentId);
    const threads = [...ids].map(
      (id) =>
        index.threads.get(threadKey(environmentId, id)) ?? (removed?.has(id) ? null : undefined),
    );
    let cached = summaries.get(issue);
    if (cached === undefined) summaries.set(issue, (cached = new Map()));
    const previous = cached.get(key);
    if (previous !== undefined && sameItems(previous.threads, threads)) return previous.result as T;
    const active = threads
      .filter((thread) => thread != null)
      .filter((thread) => issue.state === "closed" || thread.archivedAt === null);
    const inheritedIds = new Set(
      (issue.liveWork ?? []).filter((work) => work.inherited).map((work) => work.threadId),
    );
    const omittedPausedWork = (issue.liveWork ?? []).filter(
      (work) =>
        work.paused === true &&
        !index.threads.has(threadKey(environmentId, work.threadId)) &&
        !removed?.has(work.threadId),
    );
    const liveWork = active.map((thread) => {
      // An inherited subagent does not make a settled parent blue in the sidebar.
      const status = resolveSidebarThreadStatus(thread);
      return {
        threadId: thread.id,
        title: thread.title,
        ...(thread.source.role === undefined ? {} : { role: thread.source.role }),
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        worktreeExists: issue.liveWork?.find(
          (work) => work.threadId === thread.id && work.worktreePath === thread.worktreePath,
        )?.worktreeExists,
        pullRequests: thread.pullRequests
          .filter((pr) => pr.source !== "stack-dismissed")
          .map((pr) => pr.url),
        ...(status === "paused" ? { paused: true as const } : {}),
        status:
          (status === "working" ||
            (status === "waiting" && managedImplementorAwaitingSubagent(thread.source))) &&
          thread.archivedAt === null &&
          !inheritedIds.has(thread.id)
            ? ("working" as const)
            : thread.archivedAt === null && (status === "approval" || status === "input")
              ? ("waiting_on_you" as const)
              : ("idle" as const),
      };
    });
    const omittedPrUrls = new Set(omittedPausedWork.flatMap((work) => work.pullRequests ?? []));
    const pullRequests = issuePullRequests(
      [
        ...issue.closingPullRequests,
        ...(issue.pullRequests ?? []).filter(
          (pr) => "url" in pr && typeof pr.url === "string" && omittedPrUrls.has(pr.url),
        ),
      ],
      active.flatMap((thread) => thread.pullRequests),
    );
    const result = {
      ...issue,
      ...(issue.liveWork !== undefined || liveWork.length > 0
        ? { liveWork: [...liveWork, ...omittedPausedWork] }
        : {}),
      pullRequests,
      pullRequestCount: pullRequests.length,
    };
    // Avoid replacing a server row whose observable work did not change.
    const stable =
      JSON.stringify(result) === JSON.stringify(previous?.result ?? issue)
        ? (previous?.result ?? issue)
        : result;
    cached.set(key, { threads, result: stable });
    return stable as T;
  };

  const list = <T extends RepositoryIssueListResult>(
    source: T,
    environmentId: EnvironmentId,
    index: IssueWorkIndex,
  ): T => {
    let cached = lists.get(source);
    if (cached === undefined) lists.set(source, (cached = new Map()));
    let previous = cached.get(environmentId);
    if (previous === undefined) {
      previous = {
        result: source,
        associated: new Set(
          source.issues
            .filter((issue) => (issue.liveWork?.length ?? 0) > 0)
            .map((issue) => issue.number),
        ),
        positions: new Map(source.issues.map((issue, position) => [issue.number, position])),
      };
      cached.set(environmentId, previous);
    }
    for (const number of index.issues.get(scopeKey(environmentId, source.repository))?.keys() ??
      []) {
      if (previous.positions.has(number)) previous.associated.add(number);
    }
    let issues: RepositoryIssueSummary[] | undefined;
    for (const number of previous.associated) {
      const position = previous.positions.get(number)!;
      const next = summary(source.issues[position]!, source.repository, environmentId, index);
      if (next === previous.result.issues[position]) continue;
      (issues ??= [...previous.result.issues])[position] = next;
    }
    if (issues !== undefined) previous.result = { ...source, issues };
    return previous.result as T;
  };
  return { list, summary };
}
