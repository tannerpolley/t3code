import type {
  EnvironmentId,
  IssueMilestone,
  IssueRepositoryRef,
  IssueSummary,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { IssueSection } from "./IssueSection";
import { cn } from "~/lib/utils";
import { IssueRow } from "./IssueRow";
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
  readonly scope: IssueRepositoryRef;
  readonly environmentId: EnvironmentId;
  readonly groups: readonly IssueGroup[];
  readonly issuesComplete: boolean;
  readonly selectedIssueNumber?: number;
  readonly onSelect: (issue: IssueSummary) => void;
  readonly renderMilestoneActions?: (milestone: IssueMilestone) => ReactNode;
}

/**
 * A repository's milestones and their issues, expanded by default with choices persisted per group.
 */
export function IssueTree({
  scope,
  environmentId,
  groups,
  issuesComplete,
  selectedIssueNumber,
  onSelect,
  renderMilestoneActions,
}: IssueTreeProps) {
  return (
    <div data-issue-tree>
      {groups.map((group) => {
        const panelId = `issue-group-${group.id.replace(/[^a-z0-9_-]/gi, "-")}`;
        return (
          <IssueSection key={group.id} scope={{ ...scope, environmentId }} section={group.id}>
            {(collapsed, toggleCollapsed) => {
              const isExpanded = !collapsed;
              return (
                <section>
                  <div className="flex items-start gap-2">
                    <IssueTreeRow
                      level={1}
                      controls={panelId}
                      expanded={isExpanded}
                      onToggle={toggleCollapsed}
                      count={
                        issuesComplete
                          ? `${group.issues.length} ${group.issues.length === 1 ? "issue" : "issues"}`
                          : `${group.issues.length} loaded`
                      }
                    >
                      <span className="min-w-0 truncate text-sm text-foreground/90">
                        {group.title}
                      </span>
                      {group.milestone?.state === "closed" ? (
                        <IssueTreeTag>Closed</IssueTreeTag>
                      ) : null}
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
                      {group.issues.map((issue) => (
                        <li key={issue.number}>
                          <IssueRow
                            environmentId={environmentId}
                            issue={issue}
                            selected={selectedIssueNumber === issue.number}
                            onSelect={() => onSelect(issue)}
                            className={LEVEL_PADDING[2]}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              );
            }}
          </IssueSection>
        );
      })}
    </div>
  );
}
