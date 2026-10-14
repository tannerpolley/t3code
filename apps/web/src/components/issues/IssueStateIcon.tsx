import type { IssueSummary } from "@t3tools/contracts";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type IssueStateInput = Pick<IssueSummary, "state"> &
  Partial<Pick<IssueSummary, "stateReason" | "blockedBy" | "liveWork" | "projects">>;

export type IssueProgress = "completed" | "not_planned" | "blocked" | "in_progress" | "open";

/**
 * Closed wins, split the way GitHub closes an issue: not planned (or a duplicate) apart from
 * completed, which is also what an issue closed without a reason counts as. Then an open
 * blocker, then work in progress: an agent working on it or waiting on the user, or a GitHub
 * Project status of "In progress".
 */
export function issueProgress(issue: IssueStateInput): IssueProgress {
  if (issue.state === "closed")
    return issue.stateReason === "not_planned" || issue.stateReason === "duplicate"
      ? "not_planned"
      : "completed";
  if (issue.blockedBy?.some((blocker) => blocker.state === "open")) return "blocked";
  if (
    issue.liveWork?.some((work) => work.status !== "idle") ||
    issue.projects?.some((project) => /^in[\s-]?progress$/i.test(project.status ?? ""))
  )
    return "in_progress";
  return "open";
}

/** Tones match the pull request glyphs: open green, done purple, shelved gray, failing red. */
export const ISSUE_PROGRESS_PRESENTATION = {
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
