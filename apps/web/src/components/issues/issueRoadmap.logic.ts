import { issueWorkerIsLive, issueWorkerNeedsOwner } from "@t3tools/shared/issueWorkerStatus";
import {
  THREAD_ROLE_LABELS,
  type IssueRepositoryRef,
  type RepositoryIssueSummary,
} from "@t3tools/contracts";
import { issuePriorityRank } from "./issueProjects.logic";
import { issueProgress } from "./IssueStateIcon";

export function issueLiveStatus(issue: RepositoryIssueSummary) {
  const work = issue.liveWork ?? [];
  if (work.length > 0 && issue.suspensionReason !== undefined) return "suspended" as const;
  const waiting =
    work.find((worker) => issueWorkerNeedsOwner(worker) && !worker.requestHandledByParent) ??
    work.find(issueWorkerNeedsOwner);
  if (waiting !== undefined) return waiting.status;
  if (work.some(issueWorkerIsLive)) return "working" as const;
  for (const status of ["queued", "failed", "paused", "done", "working", "idle"] as const) {
    if (work.some((thread) => issueWorkerStatus(thread) === status)) return status;
  }
  return null;
}

export function issueWorkerStatus(work: NonNullable<RepositoryIssueSummary["liveWork"]>[number]) {
  return work.paused === true ? "paused" : work.status;
}

/** Put the actionable worker first so the compact row opens the right thread. */
export function issueLiveWorkSummary(issue: RepositoryIssueSummary) {
  const status = issueLiveStatus(issue);
  if (status === null) return null;
  const work = [...(issue.liveWork ?? [])].sort(
    (a, b) =>
      Number(issueWorkerStatus(b) === status) - Number(issueWorkerStatus(a) === status) ||
      Number(a.requestHandledByParent === true) - Number(b.requestHandledByParent === true) ||
      a.title.localeCompare(b.title),
  );
  const first = work[0]!;
  const agent =
    first.role === undefined ? first.title : `${THREAD_ROLE_LABELS[first.role]}: ${first.title}`;
  return { status, work, agent, more: work.length - 1 };
}
export function openIssueBlockers(issue: RepositoryIssueSummary) {
  return (issue.blockedBy ?? []).filter((blocker) => blocker.state === "open");
}

/** Native blocker and child edges are ordered before Project Priority and oldest number.
 * Strongly connected components retain ordering of downstream issues without calling them cycles.
 */
export function issueRoadmap(
  scope: IssueRepositoryRef,
  issues: readonly RepositoryIssueSummary[],
  queuedNumbers: readonly number[] = [],
  now = Date.now(),
  pendingInboxNumbers: readonly number[] = [],
) {
  const open = issues.filter((issue) => issue.state === "open");
  const byNumber = new Map(open.map((issue) => [issue.number, issue]));
  const edges = new Map(open.map((issue) => [issue.number, new Set<number>()]));
  const local = (ref: IssueRepositoryRef) =>
    ref.host.toLowerCase() === scope.host.toLowerCase() &&
    ref.repository.toLowerCase() === scope.repository.toLowerCase();
  for (const issue of open) {
    for (const blocker of openIssueBlockers(issue)) {
      if (local(blocker)) edges.get(blocker.number)?.add(issue.number);
    }
    if (issue.parent != null && local(issue.parent) && byNumber.has(issue.parent.number)) {
      edges.get(issue.number)!.add(issue.parent.number);
    }
  }
  const priorities = new Map(open.map((issue) => [issue.number, issuePriorityRank(issue)]));
  const compare = (left: number, right: number) =>
    priorities.get(left)! - priorities.get(right)! || left - right;
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const stack: number[] = [];
  const onStack = new Set<number>();
  const components: number[][] = [];
  const visit = (number: number) => {
    index.set(number, index.size);
    low.set(number, index.get(number)!);
    stack.push(number);
    onStack.add(number);
    for (const next of edges.get(number)!) {
      if (!index.has(next)) {
        visit(next);
        low.set(number, Math.min(low.get(number)!, low.get(next)!));
      } else if (onStack.has(next)) low.set(number, Math.min(low.get(number)!, index.get(next)!));
    }
    if (low.get(number) === index.get(number)) {
      const component: number[] = [];
      let current: number;
      do {
        current = stack.pop()!;
        onStack.delete(current);
        component.push(current);
      } while (current !== number);
      components.push(component.sort((a, b) => a - b));
    }
  };
  for (const issue of open) if (!index.has(issue.number)) visit(issue.number);
  const membership = new Map<number, number>();
  components.forEach((component, id) => component.forEach((number) => membership.set(number, id)));
  const outgoing = components.map(() => new Set<number>());
  const incoming = components.map(() => 0);
  for (const [from, nexts] of edges)
    for (const to of nexts) {
      const a = membership.get(from)!;
      const b = membership.get(to)!;
      if (a !== b && !outgoing[a]!.has(b)) {
        outgoing[a]!.add(b);
        incoming[b]!++;
      }
    }
  const representative = components.map((component) => [...component].sort(compare)[0]!);
  const ready: number[] = [];
  const insert = (id: number) => {
    let left = 0,
      right = ready.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (compare(representative[ready[middle]!]!, representative[id]!) < 0) left = middle + 1;
      else right = middle;
    }
    ready.splice(left, 0, id);
  };
  incoming.forEach((count, id) => {
    if (count === 0) insert(id);
  });
  const ordered: Array<{ issue: RepositoryIssueSummary; cycle: boolean }> = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    const component = components[id]!;
    const cycle = component.length > 1 || edges.get(component[0]!)!.has(component[0]!);
    for (const number of component) ordered.push({ issue: byNumber.get(number)!, cycle });
    for (const next of outgoing[id]!) if (--incoming[next]! === 0) insert(next);
  }
  const queueOrder = new Map(queuedNumbers.map((number, index) => [number, index]));
  const section = (id: string, title: string) => ({ id, title, rows: [] as typeof ordered });
  const closed = section("closed", "Closed");
  const unknown = section("dependencies-unknown", "Dependencies unknown");
  const blocked = section("blocked", "Blocked");
  const readySection = section("ready", "Ready");
  const queued = section("queued", "Queued");
  const review = section("ready-for-review", "Ready for review");
  const suspended = section("suspended", "Suspended");
  const inProgress = section("in-progress", "In progress");
  const done = section("done", "Done");
  const pendingInbox = new Set(pendingInboxNumbers);
  // Queue membership keeps its explicit order; dependency warnings remain visible on queued rows.
  for (const row of ordered) {
    if (pendingInbox.has(row.issue.number)) continue;
    const progress = issueProgress({ ...row.issue, queued: queueOrder.has(row.issue.number) });
    const target =
      progress === "suspended"
        ? suspended
        : queueOrder.has(row.issue.number) || progress === "queued"
          ? queued
          : progress === "blocked"
            ? blocked
            : progress === "in_progress"
              ? inProgress
              : progress === "ready_for_review"
                ? review
                : progress === "dependencies_unknown"
                  ? unknown
                  : readySection;
    target.rows.push(row);
  }
  queued.rows.sort(
    (left, right) =>
      (queueOrder.get(left.issue.number) ?? queueOrder.size) -
      (queueOrder.get(right.issue.number) ?? queueOrder.size),
  );
  for (const issue of issues
    .filter((issue) => issue.state === "closed")
    .toSorted(
      (a, b) =>
        (Date.parse(b.closedAt ?? "") || 0) - (Date.parse(a.closedAt ?? "") || 0) ||
        b.number - a.number,
    )) {
    (recentlyDone(issue, now) ? done : closed).rows.push({ issue, cycle: false });
  }
  return [
    done,
    inProgress,
    ...(suspended.rows.length === 0 ? [] : [suspended]),
    queued,
    ...(review.rows.length === 0 ? [] : [review]),
    readySection,
    blocked,
    ...(unknown.rows.length === 0 ? [] : [unknown]),
    closed,
  ];
}

const RECENTLY_DONE_MS = 24 * 60 * 60 * 1000;

function recentlyDone(issue: RepositoryIssueSummary, now: number) {
  if (issue.state !== "closed" || issue.closedAt == null) return false;
  const elapsed = now - Date.parse(issue.closedAt);
  return elapsed >= 0 && elapsed < RECENTLY_DONE_MS;
}

// The snapshot changes only at closure or expiry; returning the wall clock would render forever.
export function createIssueRoadmapClock(issues: readonly RepositoryIssueSummary[]) {
  const boundaries = issues
    .flatMap((issue) => {
      if (issue.state !== "closed" || issue.closedAt == null) return [];
      const closed = Date.parse(issue.closedAt);
      return Number.isFinite(closed) ? [closed, closed + RECENTLY_DONE_MS] : [];
    })
    .sort((a, b) => a - b);
  const snapshot = () => {
    const now = Date.now();
    return boundaries.findLast((time) => time <= now) ?? 0;
  };
  const subscribe = (onChange: () => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const schedule = () => {
      if (disposed) return;
      const now = Date.now();
      const next = boundaries.find((time) => time > now);
      if (next === undefined) return;
      timer = setTimeout(() => {
        onChange();
        schedule();
      }, next - now);
    };
    schedule();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  };
  return { subscribe, snapshot };
}
