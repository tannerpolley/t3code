import type { IssueSummary } from "@t3tools/contracts";
import { CheckCircle2Icon, CircleDotIcon } from "lucide-react";

import { cn } from "~/lib/utils";

type IssueStateInput = Pick<IssueSummary, "state"> &
  Partial<Pick<IssueSummary, "blockedBy" | "liveWork" | "projects">>;

export type IssueProgress = "closed" | "blocked" | "in_progress" | "open";

/**
 * Closed wins, then an open blocker, then work in progress: an agent working on it or waiting on
 * the user, or a GitHub Project status of "In progress".
 */
export function issueProgress(issue: IssueStateInput): IssueProgress {
  if (issue.state === "closed") return "closed";
  if (issue.blockedBy?.some((blocker) => blocker.state === "open")) return "blocked";
  if (
    issue.liveWork?.some((work) => work.status !== "idle") ||
    issue.projects?.some((project) => /^in[\s-]?progress$/i.test(project.status ?? ""))
  )
    return "in_progress";
  return "open";
}

const LABELS: Record<IssueProgress, string> = {
  closed: "Closed",
  blocked: "Blocked",
  in_progress: "In progress",
  open: "Open",
};
const TONES: Record<Exclude<IssueProgress, "closed">, string> = {
  blocked: "text-destructive",
  in_progress: "text-info",
  open: "text-success",
};

/** Issue rows' state mark: gray check when closed, else a red, blue or green circle. */
export function IssueStateIcon({
  issue,
  className,
}: {
  readonly issue: IssueStateInput;
  readonly className?: string;
}) {
  const progress = issueProgress(issue);
  return progress === "closed" ? (
    <CheckCircle2Icon
      aria-label={LABELS.closed}
      className={cn("shrink-0 text-muted-foreground", className)}
    />
  ) : (
    <CircleDotIcon
      aria-label={LABELS[progress]}
      className={cn("shrink-0", TONES[progress], className)}
    />
  );
}
