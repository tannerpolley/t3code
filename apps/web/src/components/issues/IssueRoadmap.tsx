import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import type {
  EnvironmentId,
  IssueMilestone,
  IssueRepositoryRef,
  IssueSummary,
} from "@t3tools/contracts";
import { CirclePauseIcon, LinkIcon } from "lucide-react";
import { IssueRow } from "./IssueRow";
import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { issueRoadmap, issueLiveStatus, openIssueBlockers } from "./issueRoadmap.logic";

function IssueLiveWork({
  issue,
  environmentId,
}: {
  issue: IssueSummary;
  environmentId: EnvironmentId;
}) {
  const navigate = useNavigate();
  const status = issueLiveStatus(issue);
  if (status === null) return null;
  const work = [...(issue.liveWork ?? [])].sort(
    (a, b) =>
      Number(b.status === status) - Number(a.status === status) || a.title.localeCompare(b.title),
  );
  const label =
    status === "working"
      ? "Working"
      : status === "waiting_on_you"
        ? "Waiting on you"
        : "Linked, idle";
  const Icon = status === "waiting_on_you" ? CirclePauseIcon : LinkIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${label}: ${work[0]!.title}`}
            className="flex shrink-0 items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: work[0]!.threadId },
              })
            }
          />
        }
      >
        {status !== "working" ? (
          <Icon
            aria-hidden
            className={cn("size-3.5", status === "waiting_on_you" && "text-warning-foreground")}
          />
        ) : null}
        <span>{label}</span>
      </TooltipTrigger>
      <TooltipPopup>
        <div className="flex max-w-96 flex-col gap-2">
          {work.map((thread) => (
            <div key={thread.threadId}>
              <p>
                {thread.title} ·{" "}
                {thread.status === "working"
                  ? "Working"
                  : thread.status === "waiting_on_you"
                    ? "Waiting on you"
                    : "Idle"}
              </p>
              {thread.branch ? <p>Branch: {thread.branch}</p> : null}
              {thread.worktreePath ? <p>Worktree: {thread.worktreePath}</p> : null}
              {thread.pullRequests.map((url) => (
                <p key={url}>Pull request: {url}</p>
              ))}
            </div>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/** The same roadmap is used in the Issues pane, browser and thread details. */
export function IssueRoadmap({
  scope,
  environmentId,
  milestones,
  issues,
  visibleNumbers,
  onSelect,
  selectedIssueNumber,
  limit = Infinity,
}: {
  scope: IssueRepositoryRef;
  environmentId: EnvironmentId;
  milestones: readonly IssueMilestone[];
  issues: readonly IssueSummary[];
  visibleNumbers?: ReadonlySet<number>;
  onSelect: (issue: IssueSummary) => void;
  selectedIssueNumber?: number;
  limit?: number;
}) {
  const sections = useMemo(
    () => issueRoadmap({ host: scope.host, repository: scope.repository }, milestones, issues),
    [scope.host, scope.repository, milestones, issues],
  );
  const shown = new Set(
    sections
      .flatMap((section) => section.rows)
      .filter((row) => visibleNumbers === undefined || visibleNumbers.has(row.issue.number))
      .slice(0, limit)
      .map((row) => row.issue.number),
  );
  return (
    <div aria-label={`Roadmap for ${scope.repository}`}>
      {sections.map((section) => {
        const rows = section.rows.filter((row) => shown.has(row.issue.number));
        return (
          <section key={section.id} aria-label={section.title}>
            <h3 className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              {section.title}
            </h3>
            <ul>
              {rows.map(({ issue, cycle }) => (
                <li key={issue.number} className="px-2 py-1">
                  <div className="flex items-start gap-1">
                    <IssueRow
                      issue={issue}
                      environmentId={environmentId}
                      selected={selectedIssueNumber === issue.number}
                      onSelect={() => onSelect(issue)}
                      className="flex-1 px-1"
                    />
                    <IssueLiveWork issue={issue} environmentId={environmentId} />
                  </div>
                  <div className="flex flex-wrap items-center gap-1 ps-6 text-xs text-muted-foreground">
                    {cycle ? (
                      <Badge variant="secondary" size="sm">
                        dependency cycle
                      </Badge>
                    ) : null}
                    {issue.relationshipsComplete === false || issue.blockedBy === undefined ? (
                      <span>Dependencies unavailable</span>
                    ) : null}
                    {openIssueBlockers(issue).length > 0 ? (
                      <span>
                        blocked by{" "}
                        {openIssueBlockers(issue).map((blocker, index) => (
                          <span key={`${blocker.host}/${blocker.repository}#${blocker.number}`}>
                            {index > 0 ? ", " : ""}
                            <a
                              className="underline"
                              href={`https://${blocker.host}/${blocker.repository}/issues/${blocker.number}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {blocker.host.toLowerCase() === scope.host.toLowerCase() &&
                              blocker.repository.toLowerCase() === scope.repository.toLowerCase()
                                ? ""
                                : `${blocker.repository}`}
                              #{blocker.number}
                            </a>
                          </span>
                        ))}
                      </span>
                    ) : issue.relationshipsComplete !== false && issue.blockedBy !== undefined ? (
                      <span>Ready</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
