import type { IssueWorkStatus, RepositoryIssueSummary } from "@t3tools/contracts";
import { issueWorkerIsLive, issueWorkerNeedsOwner } from "./issueWorkerStatus.ts";

type Worker = NonNullable<RepositoryIssueSummary["liveWork"]>[number];

export type IssueStageInput = Pick<RepositoryIssueSummary, "state"> &
  Partial<
    Pick<RepositoryIssueSummary, "stateReason" | "suspensionReason" | "relationshipsComplete">
  > & {
    readonly liveWork?:
      | readonly Pick<Worker, "status" | "inherited" | "requestHandledByParent">[]
      | undefined;
    readonly blockedBy?: readonly { readonly state: "open" | "closed" }[] | undefined;
    readonly pullRequests?: readonly { readonly state: string | null }[] | undefined;
    /** In the repository's issue queue, waiting for its orchestrator to start it. */
    readonly queued?: boolean | undefined;
  };

/** "closed" is an issue closed without completing it; it is not a pipeline stage. */
export type IssueStage =
  | "done"
  | "ready_for_review"
  | "in_progress"
  | "queued"
  | "backlog"
  | "closed";

export const ISSUE_STAGE_LABELS = {
  done: "Done",
  ready_for_review: "Ready for review",
  in_progress: "In progress",
  queued: "Queued",
  backlog: "Backlog",
  closed: "Closed",
} satisfies Record<IssueStage, string>;

/** One stage per issue: In progress, then Queued, then Ready for review. Blockers and worker trouble are badges. */
export function issueStage(issue: IssueStageInput): IssueStage {
  if (issue.state === "closed")
    return issue.stateReason === "not_planned" || issue.stateReason === "duplicate"
      ? "closed"
      : "done";
  const work = issue.liveWork ?? [];
  if (work.some(issueWorkerIsLive)) return "in_progress";
  if (issue.queued || work.some((worker) => worker.status === "queued")) return "queued";
  if (issue.pullRequests?.some((pr) => pr.state === "open")) return "ready_for_review";
  return "backlog";
}

export type IssueBadge = "blocked" | "suspended" | "needs_you" | "failed" | "dependencies_unknown";

const ISSUE_BADGE_LABELS = {
  blocked: "Blocked",
  suspended: "Suspended",
  needs_you: "Needs you",
  failed: "Failed",
  dependencies_unknown: "Dependencies unknown",
} satisfies Record<IssueBadge, string>;

export function issueBadges(issue: IssueStageInput): IssueBadge[] {
  if (issue.state === "closed") return [];
  const work = issue.liveWork ?? [];
  const badges: IssueBadge[] = [];
  if (issue.blockedBy?.some((blocker) => blocker.state === "open")) badges.push("blocked");
  if (issue.suspensionReason !== undefined) badges.push("suspended");
  if (work.some((worker) => issueWorkerNeedsOwner(worker) && !worker.requestHandledByParent))
    badges.push("needs_you");
  if (work.some((worker) => worker.status === "failed")) badges.push("failed");
  if (issue.relationshipsComplete === false) badges.push("dependencies_unknown");
  return badges;
}

/** Status comments speak the board's words for one worker's state. */
export const ISSUE_WORK_STATUS_LABELS = {
  queued_preparing: ISSUE_STAGE_LABELS.queued,
  working: ISSUE_STAGE_LABELS.in_progress,
  waiting_on_you: ISSUE_BADGE_LABELS.needs_you,
  waiting_on_sub_issues: "Waiting on sub-issues",
  done: ISSUE_STAGE_LABELS.done,
  failed: ISSUE_BADGE_LABELS.failed,
  interrupted: "Interrupted",
  cancelled: "Cancelled",
  paused: "Paused",
  unavailable: "Unavailable",
} satisfies Record<IssueWorkStatus, string>;
