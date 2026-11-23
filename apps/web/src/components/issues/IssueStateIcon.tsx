import { useGT } from "gt-react";
import {
  ISSUE_STAGE_LABELS,
  issueBadges,
  issueStage,
  type IssueBadge,
  type IssueStage,
  type IssueStageInput,
} from "@t3tools/shared/issueStage";
import {
  CircleCheckIcon,
  CircleDotDashedIcon,
  CircleDotIcon,
  CircleEllipsisIcon,
  CircleSlashIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Tones match the pull request glyphs: open green, done purple, shelved gray. */
const ISSUE_STAGE_PRESENTATION = {
  backlog: {
    label: ISSUE_STAGE_LABELS.backlog,
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
    badgeVariant: "success",
    Icon: CircleDotIcon,
  },
  in_progress: {
    label: ISSUE_STAGE_LABELS.in_progress,
    toneClassName: "text-sky-600 dark:text-sky-300/90",
    badgeVariant: "info",
    Icon: CircleDotDashedIcon,
  },
  queued: {
    label: ISSUE_STAGE_LABELS.queued,
    toneClassName: "text-indigo-600 dark:text-indigo-300/90",
    badgeVariant: "secondary",
    Icon: CircleEllipsisIcon,
  },
  ready_for_review: {
    label: ISSUE_STAGE_LABELS.ready_for_review,
    toneClassName: "text-violet-600 dark:text-violet-300/90",
    badgeVariant: "outline",
    Icon: CircleDotIcon,
  },
  done: {
    label: ISSUE_STAGE_LABELS.done,
    toneClassName: "text-violet-600 dark:text-violet-300/90",
    badgeVariant: "outline",
    Icon: CircleCheckIcon,
  },
  closed: {
    label: "Closed as not planned",
    toneClassName: "text-zinc-500 dark:text-zinc-400/80",
    badgeVariant: "secondary",
    Icon: CircleSlashIcon,
  },
} as const;

export function issueStatePresentation(issue: IssueStageInput) {
  const presentation = ISSUE_STAGE_PRESENTATION[issueStage(issue)];
  if (issue.state === "open" && issue.suspensionReason !== undefined)
    return { ...presentation, label: `Suspended: ${issue.suspensionReason}` };
  return issue.stateReason === "duplicate"
    ? { ...presentation, label: "Closed as duplicate" }
    : presentation;
}

export function useIssueStageLabels() {
  const gt = useGT();
  return {
    done: gt("Done"),
    ready_for_review: gt("Ready for review"),
    in_progress: gt("In progress"),
    queued: gt("Queued"),
    backlog: gt("Backlog"),
    closed: gt("Closed"),
  } satisfies Record<IssueStage, string>;
}

function useIssueBadgeLabels() {
  const gt = useGT();
  return {
    blocked: gt("Blocked"),
    suspended: gt("Suspended"),
    needs_you: gt("Needs you"),
    failed: gt("Failed"),
    dependencies_unknown: gt("Dependencies unknown"),
  } satisfies Record<IssueBadge, string>;
}

export function useIssueStateLabel(label: string) {
  const labels = useIssueStageLabels();
  const stage = (Object.keys(ISSUE_STAGE_LABELS) as IssueStage[]).find(
    (key) => ISSUE_STAGE_LABELS[key] === label,
  );
  return stage === undefined ? label : labels[stage];
}

/** An issue's state glyph with its name on hover, as the pull request rows draw theirs. */
export function IssueStateIcon({
  issue,
  className,
}: {
  readonly issue: IssueStageInput;
  readonly className?: string;
}) {
  const presentation = issueStatePresentation(issue);
  const label = useIssueStateLabel(presentation.label);
  return (
    <Tooltip>
      {/* A span trigger: rows are buttons, and a nested control would steal their click. */}
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <presentation.Icon
          role="img"
          aria-label={label}
          className={cn("size-4 shrink-0", presentation.toneClassName, className)}
        />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

const BADGE_VARIANTS = {
  blocked: "error",
  suspended: "warning",
  needs_you: "warning",
  failed: "error",
  dependencies_unknown: "secondary",
} as const satisfies Record<IssueBadge, string>;

/** Conditions that ride along with an issue's stage; the row's hover card names the details. */
export function IssueStageBadges({
  issue,
  cycle = false,
}: {
  readonly issue: IssueStageInput;
  readonly cycle?: boolean | undefined;
}) {
  const gt = useGT();
  const labels = useIssueBadgeLabels();
  return (
    <>
      {issueBadges(issue).map((badge) => (
        <Badge key={badge} variant={BADGE_VARIANTS[badge]} size="sm">
          {labels[badge]}
        </Badge>
      ))}
      {cycle ? (
        <Badge variant="secondary" size="sm">
          {gt("Dependency cycle")}
        </Badge>
      ) : null}
    </>
  );
}
