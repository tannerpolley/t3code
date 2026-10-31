import type { IssueSummary } from "@t3tools/contracts";
import {
  CircleAlertIcon,
  CircleHelpIcon,
  CircleCheckIcon,
  CircleDotDashedIcon,
  CircleDotIcon,
  CircleEllipsisIcon,
  CirclePauseIcon,
  CircleSlashIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type IssueStateInput = Pick<IssueSummary, "state"> &
  Partial<
    Pick<IssueSummary, "stateReason" | "projects" | "suspensionReason" | "relationshipsComplete">
  > & {
    readonly liveWork?:
      | readonly Pick<NonNullable<IssueSummary["liveWork"]>[number], "status">[]
      | undefined;
    readonly blockedBy?:
      | readonly Pick<NonNullable<IssueSummary["blockedBy"]>[number], "state">[]
      | undefined;
    readonly pullRequests?:
      | readonly Pick<NonNullable<IssueSummary["pullRequests"]>[number], "state">[]
      | undefined;
    /** In the repository's issue queue, waiting for its orchestrator to start it. */
    readonly queued?: boolean | undefined;
  };

export type IssueProgress =
  | "completed"
  | "not_planned"
  | "dependencies_unknown"
  | "blocked"
  | "in_progress"
  | "queued"
  | "suspended"
  | "paused"
  | "open";

export function issueProgress<T extends IssueStateInput>(issue: T): IssueProgress {
  if (issue.state === "closed")
    return issue.stateReason === "not_planned" || issue.stateReason === "duplicate"
      ? "not_planned"
      : "completed";
  if (issue.suspensionReason !== undefined) return "suspended";
  if (issue.blockedBy?.some((blocker) => blocker.state === "open")) return "blocked";
  const work = issue.liveWork ?? [];
  if (work.some((entry) => entry.status === "working" || entry.status === "waiting_on_you"))
    return "in_progress";
  if (issue.queued) return "queued";
  if (work.length > 0 || issue.pullRequests?.some((pr) => pr.state === "open")) return "paused";
  if (issue.relationshipsComplete === false || issue.blockedBy === undefined)
    return "dependencies_unknown";
  return "open";
}

/** Tones match the pull request glyphs: open green, done purple, shelved gray, failing red. */
export const ISSUE_PROGRESS_PRESENTATION = {
  dependencies_unknown: {
    label: "Dependencies unknown",
    toneClassName: "text-muted-foreground",
    badgeVariant: "secondary",
    Icon: CircleHelpIcon,
  },
  open: {
    label: "Open",
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
    badgeVariant: "success",
    Icon: CircleDotIcon,
  },
  in_progress: {
    label: "In progress",
    toneClassName: "text-sky-600 dark:text-sky-300/90",
    badgeVariant: "info",
    Icon: CircleDotDashedIcon,
  },
  queued: {
    label: "Queued",
    toneClassName: "text-indigo-600 dark:text-indigo-300/90",
    badgeVariant: "secondary",
    Icon: CircleEllipsisIcon,
  },
  suspended: {
    label: "Suspended",
    toneClassName: "text-amber-600 dark:text-amber-300/90",
    badgeVariant: "warning",
    Icon: CirclePauseIcon,
  },
  paused: {
    label: "Paused",
    toneClassName: "text-amber-600 dark:text-amber-300/90",
    badgeVariant: "warning",
    Icon: CirclePauseIcon,
  },
  blocked: {
    label: "Blocked",
    toneClassName: "text-red-600 dark:text-red-300/90",
    badgeVariant: "error",
    Icon: CircleAlertIcon,
  },
  completed: {
    label: "Closed as completed",
    toneClassName: "text-violet-600 dark:text-violet-300/90",
    badgeVariant: "outline",
    Icon: CircleCheckIcon,
  },
  not_planned: {
    label: "Closed as not planned",
    toneClassName: "text-zinc-500 dark:text-zinc-400/80",
    badgeVariant: "secondary",
    Icon: CircleSlashIcon,
  },
} as const;

export function issueStatePresentation(issue: IssueStateInput) {
  const presentation = ISSUE_PROGRESS_PRESENTATION[issueProgress(issue)];
  if (issue.state === "open" && issue.suspensionReason !== undefined)
    return { ...presentation, label: `Suspended: ${issue.suspensionReason}` };
  return issue.stateReason === "duplicate"
    ? { ...presentation, label: "Closed as duplicate" }
    : presentation;
}

/** An issue's state glyph with its name on hover, as the pull request rows draw theirs. */
export function IssueStateIcon({
  issue,
  className,
}: {
  readonly issue: IssueStateInput;
  readonly className?: string;
}) {
  const presentation = issueStatePresentation(issue);
  return (
    <Tooltip>
      {/* A span trigger: rows are buttons, and a nested control would steal their click. */}
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <presentation.Icon
          role="img"
          aria-label={presentation.label}
          className={cn("size-4 shrink-0", presentation.toneClassName, className)}
        />
      </TooltipTrigger>
      <TooltipPopup>{presentation.label}</TooltipPopup>
    </Tooltip>
  );
}
