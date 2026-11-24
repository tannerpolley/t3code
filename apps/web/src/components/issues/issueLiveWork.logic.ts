import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  RepositoryIssueListResult,
  IssueRepositoryRef,
  RepositoryIssueSummary,
  IssuePullRequestStatus,
  ThreadId,
} from "@t3tools/contracts";
import { classifyIssueWorker, isIssueWorkerChild } from "@t3tools/shared/issueWorkerStatus";
import { issuePullRequests } from "@t3tools/source-control-definitions/issuePullRequests";

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
  const children = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of shells) {
    threads.set(threadKey(thread.environmentId, thread.id), thread);
    if (thread.lineage.parentThreadId !== null) {
      const key = threadKey(thread.environmentId, thread.lineage.parentThreadId);
      const siblings = children.get(key);
      if (siblings === undefined) children.set(key, [thread]);
      else siblings.push(thread);
    }
    const refs = (thread.source.issues ?? []).flatMap((link) =>
      link.tracker === "github" && /^\d+$/.test(link.key)
        ? [{ host: link.host, repository: link.scope, number: Number(link.key) }]
        : [],
    );
    if (thread.linkedIssue !== undefined) refs.push(thread.linkedIssue);
    for (const ref of refs) {
      const key = scopeKey(thread.environmentId, ref);
      let repository = issues.get(key);
      if (repository === undefined) issues.set(key, (repository = new Map()));
      const linked = repository.get(ref.number) ?? [];
      if (linked.at(-1) !== thread) linked.push(thread);
      repository.set(ref.number, linked);
    }
  }
  return { threads, issues, children, removedAt };
}
type IssueWorkIndex = ReturnType<typeof indexIssueWork>;
type WorkSummary = Pick<RepositoryIssueSummary, "number"> & {
  readonly state?: RepositoryIssueSummary["state"];
  readonly liveWork?:
    | readonly (Pick<
        NonNullable<RepositoryIssueSummary["liveWork"]>[number],
        "threadId" | "inherited" | "status" | "paused" | "worktreeExists" | "requestHandledByParent"
      > & {
        readonly worktreePath?: string | null;
        readonly pullRequests?: readonly string[] | undefined;
      })[]
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
        parents: readonly (EnvironmentThreadShell | undefined)[];
        lineageParents: readonly (EnvironmentThreadShell | undefined)[];
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
    const storedWork = new Map((issue.liveWork ?? []).map((work) => [work.threadId, work]));
    const direct = index.issues.get(key)?.get(issue.number) ?? [];
    const ids = new Set([...storedWork.keys(), ...direct.map((thread) => thread.id)]);
    for (const id of ids) {
      for (const child of index.children.get(threadKey(environmentId, id)) ?? []) ids.add(child.id);
    }
    const removed = index.removedAt?.get(environmentId);
    const threads = [...ids].map(
      (id) =>
        index.threads.get(threadKey(environmentId, id)) ?? (removed?.has(id) ? null : undefined),
    );
    const parents = threads.map((thread) => {
      const routedTo = thread?.source.pendingRuntimeRequest?.routedTo;
      return routedTo === undefined
        ? undefined
        : index.threads.get(threadKey(environmentId, routedTo));
    });
    const lineageParents = threads.map((thread) => {
      const parentId =
        thread != null && isIssueWorkerChild(thread.source) ? thread.lineage.parentThreadId : null;
      return parentId === null ? undefined : index.threads.get(threadKey(environmentId, parentId));
    });
    let cached = summaries.get(issue);
    if (cached === undefined) summaries.set(issue, (cached = new Map()));
    const previous = cached.get(key);
    if (
      previous !== undefined &&
      sameItems(previous.threads, threads) &&
      sameItems(previous.parents, parents) &&
      sameItems(previous.lineageParents, lineageParents)
    )
      return previous.result as T;
    const active = threads
      .filter((thread) => thread != null)
      .filter((thread) => issue.state === "closed" || thread.archivedAt === null);
    const directIds = new Set(direct.map((thread) => thread.id));
    const omittedWork = [...ids].flatMap((id, position) => {
      const work = storedWork.get(id);
      return threads[position] === undefined && work !== undefined ? [work] : [];
    });
    const parentsByThread = new Map(
      threads.flatMap((thread, index) =>
        thread == null
          ? []
          : [[thread.id, { routed: parents[index], lineage: lineageParents[index] }] as const],
      ),
    );
    const liveWork = active.map((thread) => {
      const stored = storedWork.get(thread.id);
      const parents = parentsByThread.get(thread.id);
      return {
        threadId: thread.id,
        title: thread.title,
        ...(thread.source.role === undefined ? {} : { role: thread.source.role }),
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        worktreeExists:
          stored?.worktreePath === thread.worktreePath ? stored?.worktreeExists : undefined,
        pullRequests: thread.pullRequests
          .filter((pr) => pr.source !== "stack-dismissed")
          .map((pr) => pr.url),
        inherited: !directIds.has(thread.id) && (stored?.inherited ?? stored === undefined),
        ...classifyIssueWorker(
          thread.source,
          parents?.routed?.source,
          parents?.lineage?.pendingBackgroundTasks,
        ),
      };
    });
    const omittedPrUrls = new Set(
      omittedWork.flatMap((work) => (work.pullRequests ?? []).map((url) => url.toLowerCase())),
    );
    const pullRequests = issuePullRequests(
      [
        ...issue.closingPullRequests,
        ...(issue.pullRequests ?? []).filter((pr) =>
          omittedPrUrls.has(
            (pr.url ?? `https://${pr.host}/${pr.repository}/pull/${pr.number}`).toLowerCase(),
          ),
        ),
      ],
      active.flatMap((thread) => thread.pullRequests),
    );
    const result = {
      ...issue,
      ...(issue.liveWork !== undefined || liveWork.length > 0
        ? { liveWork: [...liveWork, ...omittedWork] }
        : {}),
      pullRequests,
      pullRequestCount: pullRequests.length,
    };
    // Avoid replacing a server row whose observable work did not change.
    const stable =
      JSON.stringify(result) === JSON.stringify(previous?.result ?? issue)
        ? (previous?.result ?? issue)
        : result;
    cached.set(key, { threads, parents, lineageParents, result: stable });
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
