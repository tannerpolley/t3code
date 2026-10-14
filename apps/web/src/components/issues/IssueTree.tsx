import type { IssueMilestone, IssueSummary } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { IssueStateIcon } from "./IssueStateIcon";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Badge } from "~/components/ui/badge";
import { issueProjectChips } from "./issueProjects.logic";
import type { IssueGroup } from "./issueTree.logic";

/** Indentation for repository, milestone and issue rows; the tree has no boxes. */
const LEVEL_PADDING = ["ps-2", "ps-6", "ps-10"] as const;

/** One disclosure row of the issue tree: chevron, label, and a right-aligned count. */
export function IssueTreeRow({
  level,
  expanded,
  onToggle,
  controls,
  count,
  className,
  children,
}: {
  readonly level: 0 | 1;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly controls: string;
  readonly count: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-controls={controls}
      aria-expanded={expanded}
      className={cn(
        "flex min-h-8 w-full cursor-pointer items-center gap-1.5 rounded-md pe-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        LEVEL_PADDING[level],
        className,
      )}
      onClick={onToggle}
    >
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
          expanded && "rotate-90",
        )}
      />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
      <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}

/** A small uppercase tag beside a repository or milestone name. */
export function IssueTreeTag({ children }: { readonly children: ReactNode }) {
  return (
    <span className="shrink-0 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

export interface IssueTreeProps {
  readonly groups: readonly IssueGroup[];
  readonly issuesComplete: boolean;
  readonly selectedIssueNumber?: number;
  readonly onSelect: (issue: IssueSummary) => void;
  readonly renderMilestoneActions?: (milestone: IssueMilestone) => ReactNode;
}

/**
 * A repository's milestones and their issues. Milestones with issues start expanded; a user's
 * choice is kept by id, so it survives refreshes.
 */
export function IssueTree({
  groups,
  issuesComplete,
  selectedIssueNumber,
  onSelect,
  renderMilestoneActions,
}: IssueTreeProps) {
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(() => new Map());

  return (
    <div data-issue-tree>
      {groups.map((group) => {
        const isExpanded = chosen.get(group.id) ?? group.issues.length > 0;
        const panelId = `issue-group-${group.id.replace(/[^a-z0-9_-]/gi, "-")}`;
        return (
          <section key={group.id}>
            <div className="flex items-start gap-2">
              <IssueTreeRow
                level={1}
                controls={panelId}
                expanded={isExpanded}
                onToggle={() => setChosen((current) => new Map(current).set(group.id, !isExpanded))}
                count={
                  issuesComplete
                    ? `${group.issues.length} ${group.issues.length === 1 ? "issue" : "issues"}`
                    : `${group.issues.length} loaded`
                }
              >
                <span className="min-w-0 truncate text-sm text-foreground/90">{group.title}</span>
                {group.milestone?.state === "closed" ? <IssueTreeTag>Closed</IssueTreeTag> : null}
              </IssueTreeRow>
              {group.milestone == null ? null : renderMilestoneActions?.(group.milestone)}
            </div>
            {isExpanded && group.issues.length === 0 ? (
              <p
                id={panelId}
                className={cn("py-1.5 text-xs text-muted-foreground", LEVEL_PADDING[2])}
              >
                No matching issues
              </p>
            ) : isExpanded ? (
              <ul id={panelId} className="pb-1">
                {group.issues.map((issue) => {
                  const selected = selectedIssueNumber === issue.number;
                  const projectChips = issueProjectChips(issue.projects);
                  return (
                    <li key={issue.number}>
                      <button
                        type="button"
                        aria-current={selected ? "page" : undefined}
                        className={cn(
                          "flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md py-1 pe-2 text-left text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                          LEVEL_PADDING[2],
                          selected && "bg-accent text-accent-foreground hover:bg-accent",
                        )}
                        onClick={() => onSelect(issue)}
                      >
                        <IssueStateIcon issue={issue} className="size-3.5" />
                        <span className="min-w-0 flex-1 break-words">
                          <span className="me-1 font-mono text-xs text-muted-foreground">
                            #{issue.number}
                          </span>
                          {issue.title || "Untitled issue"}
                          {projectChips.length > 0 ? (
                            <span className="mt-1 flex flex-wrap gap-1">
                              {projectChips.map((chip) => (
                                <Badge key={chip.key} variant="secondary" size="sm">
                                  {chip.label}
                                </Badge>
                              ))}
                            </span>
                          ) : null}
                        </span>
                        {issue.labels.length > 0 ? (
                          <span className="hidden max-w-32 shrink-0 truncate text-2xs text-muted-foreground sm:block">
                            {issue.labels[0]?.name}
                          </span>
                        ) : null}
                        <span className="hidden shrink-0 text-2xs text-muted-foreground lg:block">
                          updated {formatRelativeTimeLabel(issue.updatedAt)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
