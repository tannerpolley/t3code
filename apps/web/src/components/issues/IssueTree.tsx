import type { IssueSummary } from "@t3tools/contracts";
import { CheckCircle2Icon, ChevronRightIcon, CircleDotIcon, MilestoneIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import type { IssueGroup } from "./issueTree.logic";

export interface IssueTreeProps {
  readonly groups: readonly IssueGroup[];
  readonly issuesComplete: boolean;
  readonly selectedIssueNumber?: number;
  readonly onSelect: (issue: IssueSummary) => void;
}

function issueStateIcon(issue: IssueSummary) {
  return issue.state === "closed" ? (
    <CheckCircle2Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
  ) : (
    <CircleDotIcon aria-hidden className="size-3.5 shrink-0 text-emerald-500" />
  );
}

export function IssueTree({
  groups,
  issuesComplete,
  selectedIssueNumber,
  onSelect,
}: IssueTreeProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const initialized = useRef(false);

  useEffect(() => {
    const firstPopulated = groups.find((group) => group.issues.length > 0);
    if (firstPopulated === undefined || initialized.current) return;
    initialized.current = true;
    setExpanded((current) =>
      current.has(firstPopulated.id) ? current : new Set([...current, firstPopulated.id]),
    );
  }, [groups]);

  if (groups.length === 0) {
    return (
      <Empty className="min-h-56 flex-none py-12">
        <EmptyHeader>
          <EmptyTitle>{issuesComplete ? "No open issues" : "No issues loaded yet"}</EmptyTitle>
          <EmptyDescription>
            {issuesComplete
              ? "This project has no open GitHub issues."
              : "Load more to keep checking this project's issues."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="space-y-1 px-2 pb-5" data-issue-tree>
      {groups.map((group) => {
        const isExpanded = expanded.has(group.id);
        const panelId = `issue-group-${group.id.replace(/[^a-z0-9_-]/gi, "-")}`;
        return (
          <section key={group.id} className="overflow-hidden rounded-lg border border-border/50">
            <button
              type="button"
              aria-controls={panelId}
              aria-expanded={isExpanded}
              className="group flex min-h-10 w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(group.id)) next.delete(group.id);
                  else next.add(group.id);
                  return next;
                })
              }
            >
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                  isExpanded && "rotate-90",
                )}
              />
              <MilestoneIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{group.title}</span>
              {group.milestone?.state === "closed" ? (
                <Badge size="sm" variant="secondary">
                  Closed
                </Badge>
              ) : null}
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {issuesComplete ? group.issues.length : `${group.issues.length} loaded`}
              </span>
            </button>
            {isExpanded ? (
              <div id={panelId} className="border-t border-border/40 px-1 py-1">
                {group.issues.length > 0 ? (
                  <ul className="space-y-px">
                    {group.issues.map((issue) => {
                      const selected = selectedIssueNumber === issue.number;
                      return (
                        <li key={issue.number}>
                          <Button
                            aria-current={selected ? "page" : undefined}
                            className={cn(
                              "h-auto min-h-9 w-full justify-start rounded-md border-transparent px-2.5 py-1.5 text-left font-normal",
                              selected && "bg-accent text-accent-foreground",
                            )}
                            onClick={() => onSelect(issue)}
                            size="sm"
                            variant="ghost"
                          >
                            {issueStateIcon(issue)}
                            <span className="min-w-0 flex-1 truncate">
                              <span className="me-1 font-mono text-xs text-muted-foreground">
                                #{issue.number}
                              </span>
                              {issue.title || "Untitled issue"}
                            </span>
                            {issue.labels.length > 0 ? (
                              <span className="hidden max-w-32 shrink-0 truncate text-[11px] text-muted-foreground sm:block">
                                {issue.labels[0]?.name}
                              </span>
                            ) : null}
                            <span className="hidden shrink-0 text-[11px] text-muted-foreground lg:block">
                              updated {formatRelativeTimeLabel(issue.updatedAt)}
                            </span>
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="px-2.5 py-2 text-xs text-muted-foreground">
                    {issuesComplete ? "No open issues" : "No issues loaded yet"}
                  </p>
                )}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
