import type { IssueMilestone, IssueRepositoryRef, IssueSummary } from "@t3tools/contracts";
import { groupIssuesByMilestone } from "./issueTree.logic";
import { issuePriorityRank } from "./issueProjects.logic";
import { issueProgress } from "./IssueStateIcon";

export function issueLiveStatus(issue: IssueSummary) {
  const work = issue.liveWork ?? [];
  if (work.some((thread) => thread.status === "working")) return "working";
  if (work.some((thread) => thread.status === "waiting_on_you")) return "waiting_on_you";
  return work.length > 0 ? "idle" : null;
}
export function openIssueBlockers(issue: IssueSummary) {
  return (issue.blockedBy ?? []).filter((blocker) => blocker.state === "open");
}

/** Native blocker and child edges are ordered before milestone, Project Priority and oldest number.
 * Strongly connected components retain ordering of downstream issues without calling them cycles.
 */
export function issueRoadmap(
  scope: IssueRepositoryRef,
  milestones: readonly IssueMilestone[],
  issues: readonly IssueSummary[],
  queuedNumbers: readonly number[] = [],
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
  const milestoneRank = new Map<number, number>();
  groupIssuesByMilestone(milestones, open).forEach((group, rank) => {
    for (const issue of group.issues) milestoneRank.set(issue.number, rank);
  });
  const priorities = new Map(open.map((issue) => [issue.number, issuePriorityRank(issue)]));
  const compare = (left: number, right: number) =>
    milestoneRank.get(left)! - milestoneRank.get(right)! ||
    priorities.get(left)! - priorities.get(right)! ||
    left - right;
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
  const ordered: Array<{ issue: IssueSummary; cycle: boolean }> = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    const component = components[id]!;
    const cycle = component.length > 1 || edges.get(component[0]!)!.has(component[0]!);
    for (const number of component) ordered.push({ issue: byNumber.get(number)!, cycle });
    for (const next of outgoing[id]!) if (--incoming[next]! === 0) insert(next);
  }
  const sections = [
    { id: "in-progress", title: "In progress", rows: [] as typeof ordered },
    { id: "in-review", title: "In review", rows: [] as typeof ordered },
    { id: "ready", title: "Ready", rows: [] as typeof ordered },
    { id: "blocked", title: "Blocked", rows: [] as typeof ordered },
  ];
  // An open blocker wins over linked work, as in issueProgress, so the section matches the icon.
  for (const row of ordered) {
    const progress = issueProgress(row.issue);
    const section =
      progress === "blocked"
        ? 3
        : progress === "in_progress"
          ? 0
          : progress === "in_review"
            ? 1
            : row.issue.relationshipsComplete === false || row.issue.blockedBy === undefined
              ? 3
              : 2;
    sections[section]!.rows.push(row);
  }
  const queueOrder = new Map(queuedNumbers.map((number, index) => [number, index]));
  const queued = ordered
    .filter((row) => queueOrder.has(row.issue.number))
    .sort(
      (left, right) => queueOrder.get(left.issue.number)! - queueOrder.get(right.issue.number)!,
    );
  return [
    { id: "queued", title: "Queued", rows: queued },
    ...sections.map((section) => ({
      ...section,
      rows: section.rows.filter((row) => !queueOrder.has(row.issue.number)),
    })),
  ];
}
